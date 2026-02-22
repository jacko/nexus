use crate::events::P2PEvent;
use crate::files::merkle::{Hash, MerkleTree};
use crate::files::CHUNK_SIZE;
use crate::protocol::files::{FileRequest, FileResponse};

use libp2p::request_response::OutboundRequestId;
use libp2p::{kad, PeerId, Swarm};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Instant;

use crate::node::NexusBehaviour;

/// Status of a download.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DownloadStatus {
    FindingProviders,
    RequestingMetadata,
    Downloading,
    Paused,
    Complete,
    Failed(String),
}

/// State of a single download.
#[derive(Debug)]
pub struct DownloadState {
    pub content_hash: String,
    pub file_name: String,
    pub save_path: PathBuf,
    pub temp_path: PathBuf,
    pub status: DownloadStatus,
    pub providers: HashSet<PeerId>,
    pub size: Option<u64>,
    pub chunk_count: Option<u32>,
    pub merkle_root: Option<Hash>,
    pub chunks_received: HashSet<u32>,
    pub chunks_pending: HashSet<u32>,
    pub chunks_needed: VecDeque<u32>,
    pub bytes_downloaded: u64,
    pub started_at: Instant,
    /// Maps outbound request ID to chunk index.
    pub pending_requests: HashMap<OutboundRequestId, u32>,
    /// Request IDs from direct-peer probes (NotFound is expected, don't fail).
    pub probe_request_ids: HashSet<OutboundRequestId>,
    /// Number of outstanding probe requests (waiting for response).
    pub probes_pending: usize,
    /// Whether we already received valid metadata (ignore further metadata responses).
    pub metadata_received: bool,
    /// Per-chunk retry count. Chunks that exceed max retries are skipped (download fails).
    pub chunk_retries: HashMap<u32, u32>,
    /// Expected BLAKE3 hash of each chunk (from provider metadata, for resumable verification).
    pub chunk_hashes: Vec<Hash>,
    /// Speed samples for sliding window calculation: (time, cumulative bytes).
    pub speed_samples: VecDeque<(Instant, u64)>,
}

/// Serializable snapshot of a download for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadInfo {
    pub content_hash: String,
    pub file_name: String,
    pub status: String,
    pub chunks_received: u32,
    pub chunks_total: u32,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    pub speed_bps: u64,
    pub providers: usize,
}

/// Manages all active downloads.
pub struct DownloadManager {
    downloads: HashMap<String, DownloadState>,
    /// Kademlia query ID → content_hash (for matching provider results).
    query_to_hash: HashMap<kad::QueryId, String>,
    /// Request ID → content_hash (for matching chunk responses).
    request_to_hash: HashMap<OutboundRequestId, String>,
    /// Max concurrent chunk requests per download.
    max_concurrent_chunks: usize,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: HashMap::new(),
            query_to_hash: HashMap::new(),
            request_to_hash: HashMap::new(),
            max_concurrent_chunks: 16,
        }
    }

    /// Start a new download. Returns an error if already in progress.
    pub fn start_download(
        &mut self,
        content_hash: String,
        file_name: String,
        save_path: PathBuf,
        query_id: kad::QueryId,
    ) -> Result<(), String> {
        if self.downloads.contains_key(&content_hash) {
            return Err(format!("Download already in progress: {}", content_hash));
        }

        let temp_path = save_path.with_extension("nexus_tmp");

        self.query_to_hash
            .insert(query_id, content_hash.clone());

        self.downloads.insert(
            content_hash.clone(),
            DownloadState {
                content_hash,
                file_name,
                save_path,
                temp_path,
                status: DownloadStatus::FindingProviders,
                providers: HashSet::new(),
                size: None,
                chunk_count: None,
                merkle_root: None,
                chunks_received: HashSet::new(),
                chunks_pending: HashSet::new(),
                chunks_needed: VecDeque::new(),
                bytes_downloaded: 0,
                started_at: Instant::now(),
                pending_requests: HashMap::new(),
                probe_request_ids: HashSet::new(),
                probes_pending: 0,
                metadata_received: false,
                chunk_retries: HashMap::new(),
                chunk_hashes: Vec::new(),
                speed_samples: VecDeque::new(),
            },
        );

        Ok(())
    }

    /// Called when Kademlia returns providers for a hash.
    pub fn add_providers(
        &mut self,
        query_id: &kad::QueryId,
        providers: HashSet<PeerId>,
    ) -> Option<String> {
        let content_hash = self.query_to_hash.get(query_id)?.clone();

        if let Some(state) = self.downloads.get_mut(&content_hash) {
            state.providers.extend(providers);
        }

        Some(content_hash)
    }

    /// Finalize provider search and request metadata from the first provider.
    /// Call this after the Kademlia query finishes.
    pub fn request_metadata(
        &mut self,
        content_hash: &str,
        swarm: &mut Swarm<NexusBehaviour>,
    ) -> bool {
        let state = match self.downloads.get_mut(content_hash) {
            Some(s) => s,
            None => return false,
        };

        if state.status == DownloadStatus::Paused {
            // Don't proceed while paused — resume will re-trigger the search
            return false;
        }

        if state.providers.is_empty() {
            // Stay in FindingProviders — periodic re-search will handle it
            return false;
        }

        state.status = DownloadStatus::RequestingMetadata;

        let provider = *state.providers.iter().next().unwrap();
        let req_id = swarm
            .behaviour_mut()
            .file_transfer
            .send_request(&provider, FileRequest::Metadata {
                content_hash: content_hash.to_string(),
            });

        self.request_to_hash
            .insert(req_id, content_hash.to_string());

        true
    }

    /// Handle a metadata response. Initializes chunk tracking and starts requesting chunks.
    /// If a temp file already exists, verifies existing chunks and resumes from where we left off.
    /// Returns `true` if the download should proceed (or is already complete).
    pub fn handle_metadata(
        &mut self,
        content_hash: &str,
        size: u64,
        chunk_count: u32,
        merkle_root: String,
        chunk_hashes: Vec<String>,
    ) -> bool {
        let state = match self.downloads.get_mut(content_hash) {
            Some(s) => s,
            None => return false,
        };

        let root_bytes = match hex::decode(&merkle_root) {
            Ok(b) if b.len() == 32 => {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&b);
                arr
            }
            _ => {
                state.status = DownloadStatus::Failed("Invalid merkle root".into());
                return false;
            }
        };

        // Parse chunk hashes for verification
        let parsed_hashes: Vec<Hash> = chunk_hashes.iter()
            .filter_map(|h| {
                let bytes = hex::decode(h).ok()?;
                if bytes.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    Some(arr)
                } else {
                    None
                }
            })
            .collect();

        state.size = Some(size);
        state.chunk_count = Some(chunk_count);
        state.merkle_root = Some(root_bytes);
        state.chunk_hashes = parsed_hashes;
        // Don't override Paused status — metadata is stored but download won't start until resume
        if state.status != DownloadStatus::Paused {
            state.status = DownloadStatus::Downloading;
        }

        // Check if temp file exists and verify existing chunks
        if state.temp_path.exists() && !state.chunk_hashes.is_empty() {
            let verified = verify_existing_chunks(&state.temp_path, &state.chunk_hashes, size);
            if !verified.is_empty() {
                tracing::info!(
                    "Resuming download {}: {}/{} chunks already verified",
                    &content_hash[..12.min(content_hash.len())],
                    verified.len(),
                    chunk_count
                );
                state.bytes_downloaded = verified.iter().map(|&i| {
                    let start = i as u64 * CHUNK_SIZE as u64;
                    let end = ((i as u64 + 1) * CHUNK_SIZE as u64).min(size);
                    end - start
                }).sum();
                // Seed speed sample at current bytes so sliding window starts from resume point
                state.speed_samples.push_back((Instant::now(), state.bytes_downloaded));
                state.chunks_received = verified;
            }
        }

        // Initialize chunk queue — only request chunks we don't have
        state.chunks_needed = (0..chunk_count)
            .filter(|i| !state.chunks_received.contains(i))
            .collect();

        // All chunks already verified — download is already complete
        if state.chunks_received.len() as u32 == chunk_count {
            return true;
        }

        // Pre-allocate temp file if it doesn't exist yet
        if !state.temp_path.exists() {
            if let Err(e) = preallocate_file(&state.temp_path, size) {
                state.status = DownloadStatus::Failed(format!("Failed to create temp file: {}", e));
                return false;
            }
        }

        true
    }

    /// Request the next batch of chunks from available providers.
    pub fn request_next_chunks(
        &mut self,
        content_hash: &str,
        swarm: &mut Swarm<NexusBehaviour>,
    ) {
        let state = match self.downloads.get_mut(content_hash) {
            Some(s) if s.status == DownloadStatus::Downloading => s,
            _ => return,
        };

        if state.providers.is_empty() {
            return;
        }

        let providers: Vec<PeerId> = state.providers.iter().cloned().collect();

        while state.chunks_pending.len() < self.max_concurrent_chunks {
            let chunk_index = match state.chunks_needed.pop_front() {
                Some(i) => i,
                None => break,
            };

            // Round-robin across providers
            let provider_idx = chunk_index as usize % providers.len();
            let provider = providers[provider_idx];

            let req_id = swarm
                .behaviour_mut()
                .file_transfer
                .send_request(&provider, FileRequest::Chunk {
                    content_hash: content_hash.to_string(),
                    chunk_index,
                });

            state.chunks_pending.insert(chunk_index);
            state.pending_requests.insert(req_id, chunk_index);
            self.request_to_hash
                .insert(req_id, content_hash.to_string());
        }
    }

    /// Handle a chunk response. Verify, write to disk, update progress.
    /// Returns a P2PEvent if progress should be emitted.
    pub fn handle_chunk_response(
        &mut self,
        request_id: &OutboundRequestId,
        response: FileResponse,
    ) -> Option<P2PEvent> {
        let content_hash = self.request_to_hash.remove(request_id)?;
        let state = self.downloads.get_mut(&content_hash)?;

        match response {
            FileResponse::Chunk {
                chunk_index,
                data,
                proof,
                ..
            } => {
                state.pending_requests.remove(request_id);
                state.chunks_pending.remove(&chunk_index);

                // Verify chunk hash
                let chunk_hash = *blake3::hash(&data).as_bytes();

                // Verify Merkle proof
                if let Some(root) = &state.merkle_root {
                    if !MerkleTree::verify(root, &chunk_hash, &proof) {
                        // Bad chunk — re-queue it
                        tracing::warn!(
                            "Merkle proof failed for chunk {} of {}",
                            chunk_index,
                            content_hash
                        );
                        state.chunks_needed.push_back(chunk_index);
                        return None;
                    }
                }

                // Write chunk to temp file
                let offset = chunk_index as u64 * CHUNK_SIZE as u64;
                if let Err(e) = write_chunk(&state.temp_path, offset, &data) {
                    state.status = DownloadStatus::Failed(format!("Write error: {}", e));
                    return Some(make_error_event(state));
                }

                state.chunks_received.insert(chunk_index);
                state.bytes_downloaded += data.len() as u64;
                // Push speed sample for sliding window
                state.speed_samples.push_back((Instant::now(), state.bytes_downloaded));
                // Keep last 30 seconds of samples
                let cutoff = Instant::now() - std::time::Duration::from_secs(30);
                while state.speed_samples.len() > 2 {
                    if state.speed_samples.front().map_or(false, |(t, _)| *t < cutoff) {
                        state.speed_samples.pop_front();
                    } else {
                        break;
                    }
                }

                // Check if download is complete
                if let Some(total) = state.chunk_count {
                    if state.chunks_received.len() as u32 == total {
                        return Some(self.finalize_download(&content_hash));
                    }
                }

                Some(make_progress_event(state))
            }
            FileResponse::NotFound { .. } => {
                // Provider no longer has the file — go back to searching
                state.status = DownloadStatus::FindingProviders;
                state.providers.clear();
                // Move chunk back to needed
                if let Some(&chunk_index) = state.pending_requests.get(request_id) {
                    state.chunks_pending.remove(&chunk_index);
                    state.chunks_needed.push_back(chunk_index);
                }
                state.pending_requests.remove(request_id);
                Some(make_progress_event(state))
            }
            FileResponse::Metadata { .. } | FileResponse::Ack => {
                // Unexpected — metadata/ack responses handled separately
                None
            }
        }
    }

    /// Handle a metadata response from a provider.
    /// `from_peer` is the peer that sent the response (used to add as provider on success).
    pub fn handle_metadata_response(
        &mut self,
        request_id: &OutboundRequestId,
        response: FileResponse,
        from_peer: Option<PeerId>,
    ) -> Option<(String, P2PEvent)> {
        let content_hash = self.request_to_hash.remove(request_id)?;

        // Check if this was a probe request
        let is_probe = if let Some(state) = self.downloads.get_mut(&content_hash) {
            let was_probe = state.probe_request_ids.remove(request_id);
            if was_probe {
                state.probes_pending = state.probes_pending.saturating_sub(1);
            }
            was_probe
        } else {
            false
        };

        match response {
            FileResponse::Metadata {
                size,
                chunk_count,
                merkle_root,
                chunk_hashes,
                ..
            } => {
                // Always add the responding peer as a provider (even if metadata already received)
                if let Some(peer) = from_peer {
                    if let Some(state) = self.downloads.get_mut(&content_hash) {
                        state.providers.insert(peer);
                        tracing::info!(
                            "Added provider {} for {} (now {} providers)",
                            peer,
                            &content_hash[..12.min(content_hash.len())],
                            state.providers.len()
                        );
                    }
                }

                // Skip metadata processing if already received (provider was still added above)
                if let Some(state) = self.downloads.get(&content_hash) {
                    if state.metadata_received {
                        return None;
                    }
                }

                if self.handle_metadata(&content_hash, size, chunk_count, merkle_root, chunk_hashes) {
                    if let Some(state) = self.downloads.get_mut(&content_hash) {
                        state.metadata_received = true;
                    }

                    // Check if download is already complete (all chunks verified from temp file)
                    let all_done = self.downloads.get(&content_hash)
                        .map(|s| {
                            s.chunk_count.map_or(false, |total| s.chunks_received.len() as u32 == total)
                        })
                        .unwrap_or(false);

                    if all_done {
                        let evt = self.finalize_download(&content_hash);
                        return Some((content_hash, evt));
                    }

                    let state = self.downloads.get(&content_hash)?;
                    Some((content_hash, make_progress_event(state)))
                } else {
                    let state = self.downloads.get(&content_hash)?;
                    Some((content_hash, make_error_event(state)))
                }
            }
            FileResponse::NotFound { .. } => {
                if is_probe {
                    // This is a probe — the peer doesn't have the file. That's expected.
                    // Check if all probes are done with no success.
                    if let Some(state) = self.downloads.get(&content_hash) {
                        if state.probes_pending == 0
                            && !state.metadata_received
                            && state.providers.is_empty()
                        {
                            // All probes failed — stay in FindingProviders for periodic re-search
                            tracing::info!(
                                "No peers found for {} yet, will keep searching",
                                &content_hash[..12.min(content_hash.len())]
                            );
                            let state = self.downloads.get(&content_hash)?;
                            return Some((content_hash, make_progress_event(state)));
                        }
                    }
                    None
                } else {
                    // Non-probe NotFound — provider says they don't have it.
                    // Remove this provider and go back to searching.
                    if let Some(state) = self.downloads.get_mut(&content_hash) {
                        state.status = DownloadStatus::FindingProviders;
                        state.providers.clear();
                    }
                    let state = self.downloads.get(&content_hash)?;
                    Some((content_hash, make_progress_event(state)))
                }
            }
            _ => None,
        }
    }

    /// Finalize a completed download: verify full hash, rename temp → final.
    fn finalize_download(&mut self, content_hash: &str) -> P2PEvent {
        let state = self.downloads.get_mut(content_hash).unwrap();

        // Verify full BLAKE3 hash
        match verify_full_hash(&state.temp_path, content_hash) {
            Ok(true) => {
                // Rename temp to final
                if let Err(e) = fs::rename(&state.temp_path, &state.save_path) {
                    state.status = DownloadStatus::Failed(format!("Rename error: {}", e));
                    return make_error_event(state);
                }
                state.status = DownloadStatus::Complete;
                P2PEvent::DownloadComplete {
                    content_hash: state.content_hash.clone(),
                    file_name: state.file_name.clone(),
                    save_path: state.save_path.display().to_string(),
                    size: state.size.unwrap_or(0),
                }
            }
            Ok(false) => {
                state.status =
                    DownloadStatus::Failed("Hash verification failed".into());
                let _ = fs::remove_file(&state.temp_path);
                make_error_event(state)
            }
            Err(e) => {
                state.status = DownloadStatus::Failed(format!("Verify error: {}", e));
                make_error_event(state)
            }
        }
    }

    /// Handle a request failure (timeout, connection error).
    /// Returns (content_hash, optional error event if download failed permanently).
    pub fn handle_request_failure(
        &mut self,
        request_id: &OutboundRequestId,
    ) -> Option<(String, Option<P2PEvent>)> {
        let content_hash = self.request_to_hash.remove(request_id)?;
        let state = self.downloads.get_mut(&content_hash)?;

        // If this was a probe request, just decrement the counter
        if state.probe_request_ids.remove(request_id) {
            state.probes_pending = state.probes_pending.saturating_sub(1);
            return Some((content_hash, None));
        }

        if let Some(chunk_index) = state.pending_requests.remove(request_id) {
            state.chunks_pending.remove(&chunk_index);
            // Re-queue the failed chunk if under retry limit
            let retries = state.chunk_retries.entry(chunk_index).or_insert(0);
            *retries += 1;
            if *retries <= 3 {
                tracing::warn!(
                    "Chunk {} failed (attempt {}), re-queuing",
                    chunk_index,
                    retries
                );
                state.chunks_needed.push_back(chunk_index);
            } else {
                tracing::warn!(
                    "Chunk {} failed after {} retries, re-searching providers for {}",
                    chunk_index,
                    retries,
                    &content_hash[..12.min(content_hash.len())]
                );
                // Don't fail — go back to finding providers
                state.status = DownloadStatus::FindingProviders;
                // Move all in-flight chunks back to needed queue
                let pending: Vec<u32> = state.chunks_pending.drain().collect();
                for idx in pending {
                    state.chunks_needed.push_front(idx);
                }
                // Re-queue the failed chunk too
                state.chunks_needed.push_back(chunk_index);
                // Reset retry counts (will retry with new providers)
                state.chunk_retries.clear();
                // Clear providers (they're unreachable)
                state.providers.clear();
                // Clean up pending request mappings
                let old_reqs: Vec<OutboundRequestId> =
                    state.pending_requests.keys().cloned().collect();
                for req in old_reqs {
                    self.request_to_hash.remove(&req);
                }
                state.pending_requests.clear();

                let evt = make_progress_event(state);
                return Some((content_hash, Some(evt)));
            }
        }

        Some((content_hash, None))
    }

    /// Pause a download. Works in FindingProviders, RequestingMetadata, and Downloading states.
    pub fn pause(&mut self, content_hash: &str) {
        if let Some(state) = self.downloads.get_mut(content_hash) {
            match state.status {
                DownloadStatus::Downloading => {
                    state.status = DownloadStatus::Paused;
                    // Move pending chunks back to needed
                    let pending: Vec<u32> = state.chunks_pending.drain().collect();
                    for idx in pending {
                        state.chunks_needed.push_front(idx);
                    }
                }
                DownloadStatus::FindingProviders | DownloadStatus::RequestingMetadata => {
                    state.status = DownloadStatus::Paused;
                }
                _ => {}
            }
        }
    }

    /// Resume a paused download. Returns to Downloading if metadata was received,
    /// otherwise returns to FindingProviders to restart the search.
    pub fn resume(&mut self, content_hash: &str) {
        if let Some(state) = self.downloads.get_mut(content_hash) {
            if state.status == DownloadStatus::Paused {
                if state.metadata_received {
                    state.status = DownloadStatus::Downloading;
                } else {
                    state.status = DownloadStatus::FindingProviders;
                }
            }
        }
    }

    /// Cancel a download and clean up.
    pub fn cancel(&mut self, content_hash: &str) {
        if let Some(state) = self.downloads.remove(content_hash) {
            let _ = fs::remove_file(&state.temp_path);
            // Clean up request mappings
            for req_id in state.pending_requests.keys() {
                self.request_to_hash.remove(req_id);
            }
        }
        // Clean up query mapping
        self.query_to_hash.retain(|_, h| h != content_hash);
    }

    /// Remove a disconnected peer from all downloads' provider sets.
    /// Returns content hashes of downloads whose provider count changed (for UI update).
    pub fn remove_provider(&mut self, peer_id: &PeerId) -> Vec<String> {
        let mut changed = Vec::new();
        for (hash, state) in &mut self.downloads {
            if state.providers.remove(peer_id) {
                changed.push(hash.clone());
            }
        }
        changed
    }

    /// Get a progress event for a specific download (for UI updates after provider changes).
    pub fn progress_event(&self, content_hash: &str) -> Option<P2PEvent> {
        self.downloads.get(content_hash).map(make_progress_event)
    }

    /// Get all active downloads for UI display.
    pub fn get_active(&self) -> Vec<DownloadInfo> {
        self.downloads
            .values()
            .map(|s| {
                DownloadInfo {
                    content_hash: s.content_hash.clone(),
                    file_name: s.file_name.clone(),
                    status: match &s.status {
                        DownloadStatus::FindingProviders => "finding_providers".into(),
                        DownloadStatus::RequestingMetadata => "requesting_metadata".into(),
                        DownloadStatus::Downloading => "downloading".into(),
                        DownloadStatus::Paused => "paused".into(),
                        DownloadStatus::Complete => "complete".into(),
                        DownloadStatus::Failed(msg) => format!("failed: {}", msg),
                    },
                    chunks_received: s.chunks_received.len() as u32,
                    chunks_total: s.chunk_count.unwrap_or(0),
                    bytes_downloaded: s.bytes_downloaded,
                    bytes_total: s.size.unwrap_or(0),
                    speed_bps: sliding_window_speed(&s.speed_samples),
                    providers: s.providers.len(),
                }
            })
            .collect()
    }

    /// Check if there's a pending download for this Kademlia query.
    pub fn has_query(&self, query_id: &kad::QueryId) -> bool {
        self.query_to_hash.contains_key(query_id)
    }

    /// Check if a download has already received metadata.
    pub fn has_metadata(&self, content_hash: &str) -> bool {
        self.downloads
            .get(content_hash)
            .map_or(false, |s| s.metadata_received)
    }

    /// Get the content hash for a request ID.
    pub fn hash_for_request(&self, request_id: &OutboundRequestId) -> Option<&String> {
        self.request_to_hash.get(request_id)
    }

    /// Check if a download exists and is in downloading state.
    pub fn is_downloading(&self, content_hash: &str) -> bool {
        self.downloads
            .get(content_hash)
            .map_or(false, |s| s.status == DownloadStatus::Downloading)
    }

    /// Check if a download needs provider re-search (stuck in FindingProviders).
    pub fn needs_search(&self, content_hash: &str) -> bool {
        self.downloads
            .get(content_hash)
            .map_or(false, |s| s.status == DownloadStatus::FindingProviders)
    }

    /// Get all content hashes that need provider re-search (stuck in FindingProviders).
    pub fn downloads_needing_search(&self) -> Vec<String> {
        self.downloads
            .values()
            .filter(|s| s.status == DownloadStatus::FindingProviders)
            .map(|s| s.content_hash.clone())
            .collect()
    }

    /// Get all active downloads (Downloading/FindingProviders) for periodic provider enrichment.
    pub fn active_download_hashes(&self) -> Vec<String> {
        self.downloads
            .values()
            .filter(|s| matches!(s.status, DownloadStatus::Downloading | DownloadStatus::FindingProviders | DownloadStatus::RequestingMetadata))
            .map(|s| s.content_hash.clone())
            .collect()
    }

    /// Register a new Kademlia query for an existing download (re-search).
    pub fn register_search_query(&mut self, content_hash: &str, query_id: kad::QueryId) {
        self.query_to_hash.insert(query_id, content_hash.to_string());
    }

    /// Get the set of providers for a download (for sending notifications).
    pub fn providers_for(&self, content_hash: &str) -> Vec<PeerId> {
        self.downloads
            .get(content_hash)
            .map(|s| s.providers.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Probe all currently connected peers for a file by sending Metadata requests.
    /// This is a fallback when DHT can't find providers (common in small networks).
    pub fn probe_connected_peers(
        &mut self,
        content_hash: &str,
        swarm: &mut Swarm<NexusBehaviour>,
    ) {
        let connected: Vec<PeerId> = swarm.connected_peers().cloned().collect();
        if connected.is_empty() {
            return;
        }

        let state = match self.downloads.get_mut(content_hash) {
            Some(s) => s,
            None => return,
        };

        tracing::info!(
            "Probing {} connected peers for file {}",
            connected.len(),
            &content_hash[..12.min(content_hash.len())]
        );

        for peer in &connected {
            let req_id = swarm
                .behaviour_mut()
                .file_transfer
                .send_request(peer, FileRequest::Metadata {
                    content_hash: content_hash.to_string(),
                });

            state.probe_request_ids.insert(req_id);
            state.probes_pending += 1;
            self.request_to_hash
                .insert(req_id, content_hash.to_string());
        }
    }
}

fn preallocate_file(path: &PathBuf, size: u64) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.set_len(size).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_chunk(path: &PathBuf, offset: u64, data: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    Ok(())
}

fn verify_full_hash(path: &PathBuf, expected_hash: &str) -> Result<bool, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = blake3::Hasher::new();

    loop {
        let mut buf = Vec::with_capacity(CHUNK_SIZE);
        let n = reader.by_ref().take(CHUNK_SIZE as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let actual = hex::encode(hasher.finalize().as_bytes());
    Ok(actual == expected_hash)
}

/// Verify which chunks in an existing temp file match the expected hashes.
/// Returns the set of chunk indices that are already valid.
fn verify_existing_chunks(temp_path: &PathBuf, chunk_hashes: &[Hash], file_size: u64) -> HashSet<u32> {
    let mut verified = HashSet::new();

    let file = match fs::File::open(temp_path) {
        Ok(f) => f,
        Err(_) => return verified,
    };

    let meta = match file.metadata() {
        Ok(m) => m,
        Err(_) => return verified,
    };

    // Size must match — if it doesn't, the temp file is from a different download
    if meta.len() != file_size {
        return verified;
    }

    let mut reader = std::io::BufReader::new(file);

    for (i, expected_hash) in chunk_hashes.iter().enumerate() {
        use std::io::Read;
        let mut buf = Vec::with_capacity(CHUNK_SIZE);
        let bytes_read = match reader.by_ref().take(CHUNK_SIZE as u64).read_to_end(&mut buf) {
            Ok(n) => n,
            Err(_) => break,
        };

        if bytes_read == 0 {
            break;
        }

        let actual_hash = *blake3::hash(&buf[..bytes_read]).as_bytes();
        if actual_hash == *expected_hash {
            verified.insert(i as u32);
        }
    }

    verified
}

/// Calculate speed from a sliding window of (time, cumulative_bytes) samples.
/// Uses a 5-second window for responsive speed updates.
fn sliding_window_speed(samples: &VecDeque<(Instant, u64)>) -> u64 {
    if samples.len() < 2 {
        return 0;
    }
    let now = Instant::now();
    let window = std::time::Duration::from_secs(5);
    let cutoff = now - window;

    // Find oldest sample within the window
    let oldest = samples.iter().find(|(t, _)| *t >= cutoff).or_else(|| samples.back().map(|s| s));

    if let Some(&(oldest_time, oldest_bytes)) = oldest {
        if let Some(&(_, latest_bytes)) = samples.back() {
            let elapsed = now.duration_since(oldest_time).as_secs_f64();
            if elapsed > 0.1 {
                let bytes_in_window = latest_bytes.saturating_sub(oldest_bytes);
                return (bytes_in_window as f64 / elapsed) as u64;
            }
        }
    }
    0
}

fn make_progress_event(state: &DownloadState) -> P2PEvent {
    P2PEvent::DownloadProgress {
        content_hash: state.content_hash.clone(),
        file_name: state.file_name.clone(),
        status: match &state.status {
            DownloadStatus::FindingProviders => "finding_providers".into(),
            DownloadStatus::RequestingMetadata => "requesting_metadata".into(),
            DownloadStatus::Downloading => "downloading".into(),
            DownloadStatus::Paused => "paused".into(),
            DownloadStatus::Complete => "complete".into(),
            DownloadStatus::Failed(_) => "failed".into(),
        },
        chunks_received: state.chunks_received.len() as u32,
        chunks_total: state.chunk_count.unwrap_or(0),
        bytes_downloaded: state.bytes_downloaded,
        bytes_total: state.size.unwrap_or(0),
        speed_bps: sliding_window_speed(&state.speed_samples),
        providers: state.providers.len(),
    }
}

fn make_error_event(state: &DownloadState) -> P2PEvent {
    let msg = match &state.status {
        DownloadStatus::Failed(m) => m.clone(),
        _ => "Unknown error".into(),
    };
    P2PEvent::DownloadError {
        content_hash: state.content_hash.clone(),
        file_name: state.file_name.clone(),
        message: msg,
    }
}
