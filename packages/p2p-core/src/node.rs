use crate::config::P2PConfig;
use crate::events::{IndexedFileInfo, P2PEvent};
use crate::files::cache::FileIndexCache;
use crate::files::download::DownloadManager;
use crate::files::index::{FileIndex, ScanProgress};
use crate::files::CHUNK_SIZE;
use crate::identity::load_or_generate_keypair;
use crate::protocol::chat::{self, ChatMessage};
use crate::protocol::dm::{self, DmCodec, DmResponse};
use crate::protocol::files::{self, FileCodec, FileRequest, FileResponse};

use futures::StreamExt;
use libp2p::{
    autonat, dcutr, gossipsub, identify, kad, noise, relay,
    request_response::{self, ProtocolSupport},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

/// Commands sent from JS to the swarm event loop.
#[derive(Debug)]
pub enum NodeCommand {
    JoinRoom { room: String },
    LeaveRoom { room: String },
    SendMessage { room: String, text: String },
    SendDm { peer_id: String, text: String },
    SetNickname { nickname: String },
    GetPeers,
    IndexFolder { path: String },
    GetFileIndex,
    StartDownload { content_hash: String, file_name: String, save_path: String },
    PauseDownload { content_hash: String },
    ResumeDownload { content_hash: String },
    CancelDownload { content_hash: String },
    GetActiveDownloads,
    AddPeer { multiaddr: String },
    Shutdown,
}

/// The combined libp2p network behaviour.
#[derive(libp2p::swarm::NetworkBehaviour)]
pub struct NexusBehaviour {
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<kad::store::MemoryStore>,
    pub identify: identify::Behaviour,
    pub dm: request_response::Behaviour<DmCodec>,
    pub file_transfer: request_response::Behaviour<FileCodec>,
    pub autonat: autonat::Behaviour,
    pub relay_client: relay::client::Behaviour,
    pub dcutr: dcutr::Behaviour,
}

pub struct P2PNodeInner {
    pub cmd_tx: mpsc::Sender<NodeCommand>,
    pub peer_id: PeerId,
}

impl P2PNodeInner {
    pub async fn start(
        config: P2PConfig,
        emit: impl Fn(String) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let keypair = load_or_generate_keypair(config.identity_path.as_deref());
        let peer_id = PeerId::from(keypair.public());
        let nickname = Arc::new(Mutex::new(config.nickname.clone()));

        info!("Starting P2P node with PeerId: {peer_id}");

        let swarm = SwarmBuilder::with_existing_identity(keypair.clone())
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .map_err(|e| format!("transport error: {e}"))?
            .with_quic()
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .map_err(|e| format!("relay transport error: {e}"))?
            .with_behaviour(|key, relay_client| {
                let gossipsub = chat::build_gossipsub(key);

                let kad_config = kad::Config::new(StreamProtocol::new("/nexus/kad/1.0.0"));
                let store = kad::store::MemoryStore::new(key.public().to_peer_id());
                let kademlia = kad::Behaviour::with_config(key.public().to_peer_id(), store, kad_config);

                let identify = identify::Behaviour::new(
                    identify::Config::new(
                        "/nexus/id/1.0.0".into(),
                        key.public(),
                    )
                    .with_push_listen_addr_updates(true),
                );

                let dm = request_response::Behaviour::new(
                    [(dm::dm_protocol(), ProtocolSupport::Full)],
                    request_response::Config::default(),
                );

                let file_transfer = request_response::Behaviour::new(
                    [(files::file_protocol(), ProtocolSupport::Full)],
                    request_response::Config::default()
                        .with_request_timeout(Duration::from_secs(60)),
                );

                let autonat = autonat::Behaviour::new(
                    key.public().to_peer_id(),
                    autonat::Config {
                        only_global_ips: true,
                        ..Default::default()
                    },
                );

                let dcutr = dcutr::Behaviour::new(key.public().to_peer_id());

                Ok(NexusBehaviour {
                    gossipsub,
                    kademlia,
                    identify,
                    dm,
                    file_transfer,
                    autonat,
                    relay_client,
                    dcutr,
                })
            })
            .map_err(|e| format!("behaviour error: {e}"))?
            .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(120)))
            .build();

        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let peer_id_str = peer_id.to_string();
        let config_clone = config;

        tokio::spawn(async move {
            run_event_loop(swarm, cmd_rx, config_clone, nickname, peer_id_str, emit).await;
        });

        Ok(Self {
            cmd_tx,
            peer_id,
        })
    }
}

/// Extract PeerId from a multiaddr like /ip4/.../tcp/.../p2p/<peer_id>
fn extract_peer_id(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|p| {
        if let libp2p::multiaddr::Protocol::P2p(peer_id) = p {
            Some(peer_id)
        } else {
            None
        }
    })
}

/// Check if a multiaddr contains a loopback IP (127.x.x.x or ::1).
fn is_loopback_multiaddr(addr: &Multiaddr) -> bool {
    addr.iter().any(|p| match p {
        libp2p::multiaddr::Protocol::Ip4(ip) => ip.is_loopback(),
        libp2p::multiaddr::Protocol::Ip6(ip) => ip.is_loopback(),
        _ => false,
    })
}

fn emit_event(emit: &dyn Fn(String), event: &P2PEvent) {
    emit(event.to_json());
}

/// Map from gossipsub TopicHash to the original topic string.
struct TopicMap {
    hash_to_name: HashMap<gossipsub::TopicHash, String>,
}

impl TopicMap {
    fn new() -> Self {
        Self {
            hash_to_name: HashMap::new(),
        }
    }

    fn register(&mut self, topic: &gossipsub::IdentTopic) {
        self.hash_to_name
            .insert(topic.hash(), topic.to_string());
    }

    fn room_name(&self, hash: &gossipsub::TopicHash) -> Option<String> {
        self.hash_to_name
            .get(hash)
            .and_then(|t| chat::room_name_from_topic(t))
    }
}

/// Calculate speed from a sliding window of (time, cumulative_bytes) samples.
fn upload_sliding_speed(samples: &VecDeque<(Instant, u64)>) -> u64 {
    if samples.len() < 2 {
        return 0;
    }
    let now = Instant::now();
    let window = Duration::from_secs(5);
    let cutoff = now - window;

    let oldest = samples.iter().find(|(t, _)| *t >= cutoff).or(samples.back());
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

/// Tracks a single upload session (one peer downloading one file from us).
struct UploadSession {
    content_hash: String,
    file_name: String,
    peer_id: String,
    nickname: String,
    /// Actual number of chunks this provider has served (not chunk index).
    chunks_served: u32,
    chunks_total: u32,
    /// Actual bytes this provider has sent (sum of real chunk sizes).
    bytes_sent: u64,
    bytes_total: u64,
    last_activity: Instant,
    /// Speed samples for sliding window: (time, cumulative bytes_sent).
    speed_samples: VecDeque<(Instant, u64)>,
}

/// Tracks all active uploads (us serving files to peers).
struct UploadTracker {
    /// Key: "peer_id:content_hash"
    sessions: HashMap<String, UploadSession>,
}

impl UploadTracker {
    fn new() -> Self {
        Self { sessions: HashMap::new() }
    }

    fn session_key(peer_id: &str, content_hash: &str) -> String {
        format!("{}:{}", peer_id, content_hash)
    }

    /// Record that a peer requested metadata — start tracking an upload.
    fn on_metadata_request(
        &mut self,
        peer_id: &str,
        nickname: &str,
        content_hash: &str,
        file_name: &str,
        chunk_count: u32,
        file_size: u64,
    ) {
        let key = Self::session_key(peer_id, content_hash);
        let now = Instant::now();
        self.sessions.insert(key, UploadSession {
            content_hash: content_hash.to_string(),
            file_name: file_name.to_string(),
            peer_id: peer_id.to_string(),
            nickname: nickname.to_string(),
            chunks_served: 0,
            chunks_total: chunk_count,
            bytes_sent: 0,
            bytes_total: file_size,
            last_activity: now,
            speed_samples: VecDeque::new(),
        });
    }

    /// Record that we served a chunk. Returns an event to emit.
    /// If the session was cleaned up (e.g. stale timeout after pause), it is
    /// recreated from the provided file metadata so resumed downloads still show.
    /// Tracks actual chunks/bytes served by this provider (not chunk index position).
    fn on_chunk_served(
        &mut self,
        peer_id: &str,
        nickname: &str,
        content_hash: &str,
        chunk_index: u32,
        file_name: &str,
        chunk_count: u32,
        file_size: u64,
    ) -> P2PEvent {
        let key = Self::session_key(peer_id, content_hash);
        // Re-create session if it was cleaned up (resumed after pause/stale timeout)
        if !self.sessions.contains_key(&key) {
            let now = Instant::now();
            self.sessions.insert(key.clone(), UploadSession {
                content_hash: content_hash.to_string(),
                file_name: file_name.to_string(),
                peer_id: peer_id.to_string(),
                nickname: nickname.to_string(),
                chunks_served: 0,
                chunks_total: chunk_count,
                bytes_sent: 0,
                bytes_total: file_size,
                last_activity: now,
                speed_samples: VecDeque::new(),
            });
        }
        let session = self.sessions.get_mut(&key).unwrap();

        // Calculate actual size of this chunk (last chunk may be smaller)
        let chunk_start = chunk_index as u64 * CHUNK_SIZE as u64;
        let chunk_end = ((chunk_index as u64 + 1) * CHUNK_SIZE as u64).min(session.bytes_total);
        let actual_chunk_bytes = chunk_end.saturating_sub(chunk_start);

        // Count actual work by this provider
        session.chunks_served += 1;
        session.bytes_sent += actual_chunk_bytes;
        session.last_activity = Instant::now();

        // Push speed sample and trim old ones (keep 30s window)
        session.speed_samples.push_back((Instant::now(), session.bytes_sent));
        let cutoff = Instant::now() - Duration::from_secs(30);
        while session.speed_samples.len() > 2 {
            if session.speed_samples.front().map_or(false, |(t, _)| *t < cutoff) {
                session.speed_samples.pop_front();
            } else {
                break;
            }
        }

        // Speed from 5-second sliding window
        let speed_bps = upload_sliding_speed(&session.speed_samples);

        P2PEvent::UploadProgress {
            content_hash: session.content_hash.clone(),
            file_name: session.file_name.clone(),
            peer_id: session.peer_id.clone(),
            nickname: session.nickname.clone(),
            chunks_served: session.chunks_served,
            chunks_total: session.chunks_total,
            bytes_sent: session.bytes_sent,
            bytes_total: session.bytes_total,
            speed_bps,
        }
    }

    /// Remove all sessions for a disconnected peer. Returns UploadComplete events.
    fn remove_peer(&mut self, peer_id: &str) -> Vec<P2PEvent> {
        let prefix = format!("{}:", peer_id);
        let keys: Vec<String> = self.sessions.keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        let mut events = Vec::new();
        for key in keys {
            if let Some(session) = self.sessions.remove(&key) {
                events.push(P2PEvent::UploadComplete {
                    content_hash: session.content_hash,
                    file_name: session.file_name,
                    peer_id: session.peer_id,
                    nickname: session.nickname,
                    bytes_total: session.bytes_sent,
                });
            }
        }
        events
    }

    /// Handle an explicit notification from a downloader (paused/cancelled/completed).
    /// Removes the session and returns an UploadComplete event if the session existed.
    fn on_download_notify(&mut self, peer_id: &str, content_hash: &str, status: &str) -> Option<P2PEvent> {
        let key = Self::session_key(peer_id, content_hash);
        if let Some(session) = self.sessions.remove(&key) {
            tracing::info!(
                "Download notification from {}: {} for {} (served {} chunks)",
                &peer_id[..8.min(peer_id.len())],
                status,
                &content_hash[..12.min(content_hash.len())],
                session.chunks_served,
            );
            Some(P2PEvent::UploadComplete {
                content_hash: session.content_hash,
                file_name: session.file_name,
                peer_id: session.peer_id,
                nickname: session.nickname,
                bytes_total: session.bytes_sent,
            })
        } else {
            None
        }
    }

    /// Remove stale sessions (no activity for `timeout`). Returns UploadComplete events.
    fn remove_stale(&mut self, timeout: Duration) -> Vec<P2PEvent> {
        let now = Instant::now();
        let stale_keys: Vec<String> = self.sessions.iter()
            .filter(|(_, s)| now.duration_since(s.last_activity) > timeout)
            .map(|(k, _)| k.clone())
            .collect();
        let mut events = Vec::new();
        for key in stale_keys {
            if let Some(session) = self.sessions.remove(&key) {
                events.push(P2PEvent::UploadComplete {
                    content_hash: session.content_hash,
                    file_name: session.file_name,
                    peer_id: session.peer_id,
                    nickname: session.nickname,
                    bytes_total: session.bytes_sent,
                });
            }
        }
        events
    }
}

/// All mutable state for the event loop.
struct LoopState {
    topic_map: TopicMap,
    peer_nicknames: HashMap<String, String>,
    room_members: HashMap<String, HashSet<String>>,
    seen_messages: VecDeque<gossipsub::MessageId>,
    file_index: FileIndex,
    download_manager: DownloadManager,
    file_cache: FileIndexCache,
    cache_path: PathBuf,
    upload_tracker: UploadTracker,
    nat_status: String,
    bootstrap_peers: HashSet<PeerId>,
    /// Full multiaddrs for bootstrap peers (needed for relay circuit addresses).
    bootstrap_addrs: HashMap<PeerId, Multiaddr>,
    external_addr: Option<String>,
    relay_reserved: bool,
    relay_reservation_pending: bool,
}

async fn run_event_loop(
    mut swarm: Swarm<NexusBehaviour>,
    mut cmd_rx: mpsc::Receiver<NodeCommand>,
    config: P2PConfig,
    nickname: Arc<Mutex<String>>,
    peer_id: String,
    emit: impl Fn(String) + Send + Sync + 'static,
) {
    // Listen on TCP
    let tcp_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", config.listen_port)
        .parse()
        .expect("valid TCP listen addr");
    swarm.listen_on(tcp_addr).expect("can listen on TCP");

    // Listen on QUIC (same port number, different L4 protocol)
    let quic_addr: Multiaddr = format!("/ip4/0.0.0.0/udp/{}/quic-v1", config.listen_port)
        .parse()
        .expect("valid QUIC listen addr");
    swarm.listen_on(quic_addr).expect("can listen on QUIC");

    // Connect to bootstrap peers and collect their PeerIds + full multiaddrs
    let mut bootstrap_peer_ids = HashSet::new();
    let mut bootstrap_addrs_map: HashMap<PeerId, Multiaddr> = HashMap::new();
    for addr_str in &config.bootstrap_peers {
        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
            if let Some(peer) = extract_peer_id(&addr) {
                bootstrap_peer_ids.insert(peer);
                // Store the addr without the trailing /p2p/<peer_id> for relay circuit construction
                let transport_addr: Multiaddr = addr.iter()
                    .filter(|p| !matches!(p, libp2p::multiaddr::Protocol::P2p(_)))
                    .collect();
                bootstrap_addrs_map.entry(peer).or_insert(transport_addr);
                swarm
                    .behaviour_mut()
                    .kademlia
                    .add_address(&peer, addr.clone());
            }
            if let Err(e) = swarm.dial(addr.clone()) {
                warn!("Failed to dial bootstrap {addr_str}: {e}");
            } else {
                info!("Dialing bootstrap: {addr_str}");
            }
        }
    }

    let emit_arc: Arc<dyn Fn(String) + Send + Sync> = Arc::new(emit);

    // Derive cache path from identity_path directory
    let cache_path = config
        .identity_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("file-index-cache.json");

    let file_cache = FileIndexCache::load(&cache_path);
    info!("Loaded file index cache from {} ({} entries)", cache_path.display(), file_cache.entries.len());

    let mut state = LoopState {
        topic_map: TopicMap::new(),
        peer_nicknames: HashMap::new(),
        room_members: HashMap::new(),
        seen_messages: VecDeque::new(),
        file_index: FileIndex::default(),
        download_manager: DownloadManager::new(),
        file_cache,
        cache_path,
        upload_tracker: UploadTracker::new(),
        nat_status: "unknown".to_string(),
        bootstrap_peers: bootstrap_peer_ids,
        bootstrap_addrs: bootstrap_addrs_map,
        external_addr: None,
        relay_reserved: false,
        relay_reservation_pending: false,
    };
    let mut reconnect_interval = tokio::time::interval(Duration::from_secs(30));
    let mut upload_cleanup_interval = tokio::time::interval(Duration::from_secs(5));
    let mut provider_search_interval = tokio::time::interval(Duration::from_secs(15));

    loop {
        tokio::select! {
            event = swarm.select_next_some() => {
                handle_swarm_event(event, &mut swarm, &emit_arc, &peer_id, &mut state);
            }

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(NodeCommand::JoinRoom { room }) => {
                        let topic = chat::room_topic(&room);
                        state.topic_map.register(&topic);
                        if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&topic) {
                            warn!("Failed to subscribe to {room}: {e}");
                        } else {
                            let nick = nickname.lock().await.clone();
                            let msg = ChatMessage::new_join(&peer_id, &nick);
                            if let Ok(data) = serde_json::to_vec(&msg) {
                                swarm.behaviour_mut().gossipsub.publish(topic, data).ok();
                            }
                        }
                    }

                    Some(NodeCommand::LeaveRoom { room }) => {
                        let topic = chat::room_topic(&room);
                        let nick = nickname.lock().await.clone();
                        let msg = ChatMessage::new_leave(&peer_id, &nick);
                        if let Ok(data) = serde_json::to_vec(&msg) {
                            swarm.behaviour_mut().gossipsub.publish(topic.clone(), data).ok();
                        }
                        swarm.behaviour_mut().gossipsub.unsubscribe(&topic).ok();
                    }

                    Some(NodeCommand::SendMessage { room, text }) => {
                        let topic = chat::room_topic(&room);
                        let nick = nickname.lock().await.clone();
                        let msg = ChatMessage::new_text(&peer_id, &nick, &text);
                        if let Ok(data) = serde_json::to_vec(&msg) {
                            if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, data) {
                                warn!("Failed to publish message: {e}");
                                emit_event(&*emit_arc, &P2PEvent::Error {
                                    message: format!("Failed to send message: {e}"),
                                });
                            }
                        }
                    }

                    Some(NodeCommand::SendDm { peer_id: target, text }) => {
                        if let Ok(target_peer) = target.parse::<PeerId>() {
                            let nick = nickname.lock().await.clone();
                            let dm = crate::protocol::dm::DirectMessage::new(&peer_id, &nick, &text);
                            swarm.behaviour_mut().dm.send_request(&target_peer, dm);
                        } else {
                            emit_event(&*emit_arc, &P2PEvent::Error {
                                message: format!("Invalid peer ID: {target}"),
                            });
                        }
                    }

                    Some(NodeCommand::SetNickname { nickname: new_nick }) => {
                        *nickname.lock().await = new_nick;
                    }

                    Some(NodeCommand::GetPeers) => {
                        let count = swarm.connected_peers().count();
                        emit_event(&*emit_arc, &P2PEvent::Status {
                            connected: count > 0,
                            peer_id: peer_id.clone(),
                            peer_count: count,
                        });
                    }

                    Some(NodeCommand::IndexFolder { path }) => {
                        let emit_clone = emit_arc.clone();
                        let path_clone = path.clone();
                        let cache_snapshot = state.file_cache.clone();

                        state.file_index.remove_folder(std::path::Path::new(&path));

                        let result = tokio::task::spawn_blocking(move || {
                            FileIndex::scan_folder(
                                std::path::Path::new(&path_clone),
                                &cache_snapshot,
                                |progress: ScanProgress| {
                                    emit_event(&*emit_clone, &P2PEvent::IndexProgress {
                                        folder: progress.folder,
                                        files_scanned: progress.files_scanned,
                                        files_total: progress.files_total,
                                        current_file: progress.current_file,
                                    });
                                },
                            )
                        })
                        .await;

                        match result {
                            Ok(Ok((entries, trees, new_cache_entries))) => {
                                let file_count = entries.len() as u32;

                                let indexed_files: Vec<IndexedFileInfo> = entries.iter().map(|e| {
                                    IndexedFileInfo {
                                        content_hash: e.content_hash.clone(),
                                        relative_path: e.relative_path.clone(),
                                        size: e.size,
                                    }
                                }).collect();

                                for entry in &entries {
                                    if let Ok(hash_bytes) = hex::decode(&entry.content_hash) {
                                        let key = kad::RecordKey::new(&hash_bytes);
                                        swarm.behaviour_mut().kademlia.start_providing(key).ok();
                                    }
                                }

                                state.file_index.add_entries(entries, trees);

                                // Update and persist the cache
                                for ce in new_cache_entries {
                                    state.file_cache.insert(ce);
                                }
                                state.file_cache.save(&state.cache_path);

                                emit_event(&*emit_arc, &P2PEvent::IndexComplete {
                                    folder: path,
                                    file_count,
                                    files: indexed_files,
                                });
                            }
                            Ok(Err(e)) => {
                                emit_event(&*emit_arc, &P2PEvent::Error {
                                    message: format!("Index failed: {}", e),
                                });
                            }
                            Err(e) => {
                                emit_event(&*emit_arc, &P2PEvent::Error {
                                    message: format!("Index task panicked: {}", e),
                                });
                            }
                        }
                    }

                    Some(NodeCommand::GetFileIndex) => {
                        let entries: Vec<_> = state.file_index.by_hash.values().collect();
                        if let Ok(json) = serde_json::to_string(&entries) {
                            emit_event(&*emit_arc, &P2PEvent::Error {
                                message: format!("__file_index:{}", json),
                            });
                        }
                    }

                    Some(NodeCommand::StartDownload { content_hash, file_name, save_path }) => {
                        let hash_bytes = match hex::decode(&content_hash) {
                            Ok(b) => b,
                            Err(e) => {
                                emit_event(&*emit_arc, &P2PEvent::DownloadError {
                                    content_hash: content_hash.clone(),
                                    file_name: file_name.clone(),
                                    message: format!("Invalid hash: {}", e),
                                });
                                continue;
                            }
                        };

                        let key = kad::RecordKey::new(&hash_bytes);
                        let query_id = swarm.behaviour_mut().kademlia.get_providers(key);

                        if let Err(e) = state.download_manager.start_download(
                            content_hash.clone(),
                            file_name.clone(),
                            PathBuf::from(save_path),
                            query_id,
                        ) {
                            emit_event(&*emit_arc, &P2PEvent::DownloadError {
                                content_hash,
                                file_name,
                                message: e,
                            });
                        } else {
                            // Also probe all connected peers directly as a fallback
                            // (DHT may not work in small networks without bootstrap nodes)
                            state.download_manager.probe_connected_peers(&content_hash, &mut swarm);
                        }
                    }

                    Some(NodeCommand::PauseDownload { content_hash }) => {
                        let providers = state.download_manager.providers_for(&content_hash);
                        state.download_manager.pause(&content_hash);
                        notify_providers(&providers, &content_hash, "paused", &mut swarm);
                        if let Some(evt) = state.download_manager.progress_event(&content_hash) {
                            emit_event(&*emit_arc, &evt);
                        }
                    }

                    Some(NodeCommand::ResumeDownload { content_hash }) => {
                        state.download_manager.resume(&content_hash);
                        if state.download_manager.has_metadata(&content_hash) {
                            state.download_manager.request_next_chunks(&content_hash, &mut swarm);
                        } else {
                            // Was paused before metadata — try requesting if providers available
                            state.download_manager.request_metadata(&content_hash, &mut swarm);
                        }
                        if let Some(evt) = state.download_manager.progress_event(&content_hash) {
                            emit_event(&*emit_arc, &evt);
                        }
                    }

                    Some(NodeCommand::CancelDownload { content_hash }) => {
                        let providers = state.download_manager.providers_for(&content_hash);
                        state.download_manager.cancel(&content_hash);
                        notify_providers(&providers, &content_hash, "cancelled", &mut swarm);
                    }

                    Some(NodeCommand::GetActiveDownloads) => {
                        let active = state.download_manager.get_active();
                        if let Ok(json) = serde_json::to_string(&active) {
                            emit_event(&*emit_arc, &P2PEvent::Error {
                                message: format!("__active_downloads:{}", json),
                            });
                        }
                    }

                    Some(NodeCommand::AddPeer { multiaddr }) => {
                        if let Ok(addr) = multiaddr.parse::<Multiaddr>() {
                            if let Some(peer) = extract_peer_id(&addr) {
                                swarm.behaviour_mut().kademlia.add_address(&peer, addr.clone());
                                // Only dial if not already connected
                                if !swarm.is_connected(&peer) {
                                    if let Err(e) = swarm.dial(addr) {
                                        warn!("Failed to dial peer: {e}");
                                    }
                                } else {
                                    info!("Already connected to {peer}, skipping dial");
                                }
                            } else {
                                // No peer ID in multiaddr, just try to dial
                                if let Err(e) = swarm.dial(addr) {
                                    warn!("Failed to dial peer: {e}");
                                }
                            }
                            // Trigger Kademlia bootstrap to propagate routing table
                            swarm.behaviour_mut().kademlia.bootstrap().ok();
                        }
                    }

                    Some(NodeCommand::Shutdown) | None => {
                        info!("Shutting down P2P node");
                        break;
                    }
                }
            }

            _ = reconnect_interval.tick() => {
                let connected = swarm.connected_peers().count();
                if connected == 0 && !config.bootstrap_peers.is_empty() {
                    info!("No peers connected, redialing bootstrap nodes...");
                    for addr_str in &config.bootstrap_peers {
                        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                            swarm.dial(addr).ok();
                        }
                    }
                }
                emit_event(&*emit_arc, &P2PEvent::Status {
                    connected: connected > 0,
                    peer_id: peer_id.clone(),
                    peer_count: connected,
                });
            }

            _ = upload_cleanup_interval.tick() => {
                // Clean up stale uploads (no chunk served in 60s = paused/abandoned)
                // Note: actual disconnections are handled immediately by remove_peer().
                // This timeout only covers peers that are still connected but stopped requesting.
                for evt in state.upload_tracker.remove_stale(Duration::from_secs(60)) {
                    emit_event(&*emit_arc, &evt);
                }
            }

            _ = provider_search_interval.tick() => {
                // Discover providers for all active downloads (FindingProviders + Downloading)
                // This finds new peers that joined and have the file, enabling multi-source
                let hashes = state.download_manager.active_download_hashes();
                for hash in hashes {
                    let hash_bytes = match hex::decode(&hash) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let key = kad::RecordKey::new(&hash_bytes);
                    let query_id = swarm.behaviour_mut().kademlia.get_providers(key);
                    state.download_manager.register_search_query(&hash, query_id);
                    state.download_manager.probe_connected_peers(&hash, &mut swarm);
                    if state.download_manager.needs_search(&hash) {
                        info!("Re-searching providers for {}", &hash[..12.min(hash.len())]);
                    }
                }
            }
        }
    }
}

fn handle_swarm_event(
    event: libp2p::swarm::SwarmEvent<NexusBehaviourEvent>,
    swarm: &mut Swarm<NexusBehaviour>,
    emit: &Arc<dyn Fn(String) + Send + Sync>,
    my_peer_id: &str,
    state: &mut LoopState,
) {
    use libp2p::swarm::SwarmEvent;

    match event {
        // ---- Gossipsub: incoming message ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Gossipsub(gossipsub::Event::Message {
            message, message_id, ..
        })) => {
            if state.seen_messages.contains(&message_id) {
                return;
            }
            state.seen_messages.push_back(message_id);
            if state.seen_messages.len() > 500 {
                state.seen_messages.pop_front();
            }

            if let Some(room) = state.topic_map.room_name(&message.topic) {
                if let Ok(chat_msg) = serde_json::from_slice::<ChatMessage>(&message.data) {
                    if chat_msg.sender == my_peer_id {
                        return;
                    }
                    state.peer_nicknames.insert(chat_msg.sender.clone(), chat_msg.nickname.clone());

                    match chat_msg.msg_type.as_str() {
                        "message" => {
                            emit_event(&**emit, &P2PEvent::Message {
                                room,
                                sender: chat_msg.sender,
                                nickname: chat_msg.nickname,
                                text: chat_msg.text,
                                timestamp: chat_msg.timestamp,
                            });
                        }
                        "join" => {
                            state.room_members
                                .entry(room)
                                .or_default()
                                .insert(chat_msg.sender);
                        }
                        "leave" => {
                            if let Some(members) = state.room_members.get_mut(&room) {
                                members.remove(&chat_msg.sender);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // ---- Gossipsub: peer subscribed ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Gossipsub(gossipsub::Event::Subscribed {
            peer_id: sub_peer,
            topic,
        })) => {
            if let Some(room) = state.topic_map.room_name(&topic) {
                let pid = sub_peer.to_string();
                state.room_members.entry(room.clone()).or_default().insert(pid.clone());
                let nick = state.peer_nicknames
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| pid[..8.min(pid.len())].to_string());
                emit_event(&**emit, &P2PEvent::PeerJoined {
                    peer_id: pid,
                    nickname: nick,
                    room,
                });
            }
        }

        // ---- Gossipsub: peer unsubscribed ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Gossipsub(
            gossipsub::Event::Unsubscribed {
                peer_id: unsub_peer,
                topic,
            },
        )) => {
            if let Some(room) = state.topic_map.room_name(&topic) {
                let pid = unsub_peer.to_string();
                if let Some(members) = state.room_members.get_mut(&room) {
                    members.remove(&pid);
                }
                let nick = state.peer_nicknames
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| pid[..8.min(pid.len())].to_string());
                emit_event(&**emit, &P2PEvent::PeerLeft {
                    peer_id: pid,
                    nickname: nick,
                    room,
                });
            }
        }

        // ---- DM: incoming request ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Dm(request_response::Event::Message {
            message:
                request_response::Message::Request {
                    request, channel, ..
                },
            ..
        })) => {
            state.peer_nicknames.insert(request.sender.clone(), request.nickname.clone());
            emit_event(&**emit, &P2PEvent::DirectMessage {
                sender: request.sender,
                nickname: request.nickname,
                text: request.text,
                timestamp: request.timestamp,
            });
            swarm
                .behaviour_mut()
                .dm
                .send_response(channel, DmResponse { accepted: true })
                .ok();
        }

        // ---- File Transfer: incoming request (we are the provider) ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::FileTransfer(
            request_response::Event::Message {
                peer: req_peer,
                message: request_response::Message::Request { request, channel, .. },
                ..
            },
        )) => {
            let req_peer_str = req_peer.to_string();
            let req_nick = state.peer_nicknames
                .get(&req_peer_str)
                .cloned()
                .unwrap_or_else(|| req_peer_str[..8.min(req_peer_str.len())].to_string());

            match request {
                FileRequest::Metadata { content_hash } => {
                    let response = if let Some(entry) = state.file_index.get(&content_hash) {
                        let chunk_hashes = state.file_index.get_tree(&content_hash)
                            .map(|tree| tree.leaf_hashes().iter().map(hex::encode).collect())
                            .unwrap_or_default();
                        // Start tracking this upload
                        state.upload_tracker.on_metadata_request(
                            &req_peer_str,
                            &req_nick,
                            &content_hash,
                            &entry.relative_path,
                            entry.chunk_count,
                            entry.size,
                        );
                        // Emit initial progress event (0 chunks served)
                        emit_event(&**emit, &P2PEvent::UploadProgress {
                            content_hash: content_hash.clone(),
                            file_name: entry.relative_path.clone(),
                            peer_id: req_peer_str.clone(),
                            nickname: req_nick.clone(),
                            chunks_served: 0,
                            chunks_total: entry.chunk_count,
                            bytes_sent: 0,
                            bytes_total: entry.size,
                            speed_bps: 0,
                        });
                        FileResponse::Metadata {
                            content_hash,
                            size: entry.size,
                            chunk_count: entry.chunk_count,
                            merkle_root: entry.merkle_root.clone(),
                            chunk_hashes,
                        }
                    } else {
                        FileResponse::NotFound { content_hash }
                    };
                    swarm.behaviour_mut().file_transfer.send_response(channel, response).ok();
                }
                FileRequest::DownloadNotify { content_hash, status } => {
                    // Downloader is telling us they paused/cancelled/completed
                    if let Some(evt) = state.upload_tracker.on_download_notify(
                        &req_peer_str,
                        &content_hash,
                        &status,
                    ) {
                        emit_event(&**emit, &evt);
                    }
                    swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Ack).ok();
                }
                FileRequest::Chunk { content_hash, chunk_index } => {
                    let response = match (
                        state.file_index.get(&content_hash),
                        state.file_index.get_tree(&content_hash),
                    ) {
                        (Some(entry), Some(tree)) => {
                            match read_chunk_from_disk(&entry.path, chunk_index) {
                                Ok(data) => {
                                    let proof = tree.proof(chunk_index as usize);
                                    // Track upload progress (auto-recreates session if cleaned up)
                                    let evt = state.upload_tracker.on_chunk_served(
                                        &req_peer_str,
                                        &req_nick,
                                        &content_hash,
                                        chunk_index,
                                        &entry.relative_path,
                                        entry.chunk_count,
                                        entry.size,
                                    );
                                    emit_event(&**emit, &evt);
                                    FileResponse::Chunk { content_hash, chunk_index, data, proof }
                                }
                                Err(e) => {
                                    warn!("Failed to read chunk: {}", e);
                                    FileResponse::NotFound { content_hash }
                                }
                            }
                        }
                        _ => FileResponse::NotFound { content_hash },
                    };
                    swarm.behaviour_mut().file_transfer.send_response(channel, response).ok();
                }
            }
        }

        // ---- File Transfer: response received (we are the downloader) ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::FileTransfer(
            request_response::Event::Message {
                peer: resp_peer,
                message: request_response::Message::Response { request_id, response },
                ..
            },
        )) => {
            match &response {
                FileResponse::Metadata { .. } | FileResponse::NotFound { .. } | FileResponse::Ack => {
                    if let Some((hash, evt)) =
                        state.download_manager.handle_metadata_response(&request_id, response, Some(resp_peer))
                    {
                        // If download completed from resume, notify providers
                        if matches!(&evt, P2PEvent::DownloadComplete { .. }) {
                            let providers = state.download_manager.providers_for(&hash);
                            notify_providers(&providers, &hash, "completed", swarm);
                        }
                        emit_event(&**emit, &evt);
                        if state.download_manager.needs_search(&hash) {
                            // Provider not found — re-search will happen on next interval tick
                        } else {
                            state.download_manager.request_next_chunks(&hash, swarm);
                        }
                    }
                }
                FileResponse::Chunk { .. } => {
                    // Get the hash + providers before handling (since handle consumes the request_id mapping)
                    let maybe_hash = state.download_manager.hash_for_request(&request_id).cloned();
                    let providers_before = maybe_hash.as_ref()
                        .map(|h| state.download_manager.providers_for(h))
                        .unwrap_or_default();
                    if let Some(evt) = state.download_manager.handle_chunk_response(&request_id, response) {
                        // If download just completed, notify providers
                        if matches!(&evt, P2PEvent::DownloadComplete { .. }) {
                            notify_providers(&providers_before, maybe_hash.as_deref().unwrap_or(""), "completed", swarm);
                        }
                        emit_event(&**emit, &evt);
                    }
                    if let Some(hash) = maybe_hash {
                        // If download went back to FindingProviders (e.g. NotFound), trigger re-search
                        if state.download_manager.needs_search(&hash) {
                            if let Ok(hash_bytes) = hex::decode(&hash) {
                                let key = kad::RecordKey::new(&hash_bytes);
                                let query_id = swarm.behaviour_mut().kademlia.get_providers(key);
                                state.download_manager.register_search_query(&hash, query_id);
                                state.download_manager.probe_connected_peers(&hash, swarm);
                            }
                        } else {
                            state.download_manager.request_next_chunks(&hash, swarm);
                        }
                    }
                }
            }
        }

        // ---- File Transfer: outbound failure ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::FileTransfer(
            request_response::Event::OutboundFailure { request_id, error, .. },
        )) => {
            warn!("File transfer request failed: {error}");
            if let Some((hash, maybe_evt)) = state.download_manager.handle_request_failure(&request_id) {
                if let Some(evt) = maybe_evt {
                    emit_event(&**emit, &evt);
                }
                // If download went back to FindingProviders, trigger immediate re-search
                if state.download_manager.needs_search(&hash) {
                    if let Ok(hash_bytes) = hex::decode(&hash) {
                        let key = kad::RecordKey::new(&hash_bytes);
                        let query_id = swarm.behaviour_mut().kademlia.get_providers(key);
                        state.download_manager.register_search_query(&hash, query_id);
                        state.download_manager.probe_connected_peers(&hash, swarm);
                        info!("Immediate re-search for providers of {}", &hash[..12.min(hash.len())]);
                    }
                } else {
                    state.download_manager.request_next_chunks(&hash, swarm);
                }
            }
        }

        // ---- Kademlia: found providers ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Kademlia(
            kad::Event::OutboundQueryProgressed {
                id,
                result: kad::QueryResult::GetProviders(Ok(
                    kad::GetProvidersOk::FoundProviders { providers, .. },
                )),
                ..
            },
        )) => {
            if state.download_manager.has_query(&id) {
                let peer_ids: HashSet<PeerId> = providers.into_iter().collect();
                if let Some(hash) = state.download_manager.add_providers(&id, peer_ids) {
                    if !state.download_manager.has_metadata(&hash) {
                        // First time finding providers — request metadata
                        state.download_manager.request_metadata(&hash, swarm);
                    } else {
                        // Already downloading — new providers are added to the set
                        // and will be used by request_next_chunks automatically
                        info!("DHT found additional providers for {}", &hash[..12.min(hash.len())]);
                    }
                }
            }
        }

        // ---- Identify: learn peer addresses ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Identify(identify::Event::Received {
            peer_id: id_peer,
            info,
            ..
        })) => {
            // Only add non-loopback addresses to Kademlia
            for addr in info.listen_addrs {
                if !is_loopback_multiaddr(&addr) {
                    swarm.behaviour_mut().kademlia.add_address(&id_peer, addr);
                }
            }

            // Extract our external IP from the observed address (works behind NAT too)
            if state.external_addr.is_none() {
                let ip_str = info.observed_addr.iter().find_map(|p| match p {
                    libp2p::multiaddr::Protocol::Ip4(ip) if !ip.is_loopback() && !ip.is_private() => {
                        Some(ip.to_string())
                    }
                    libp2p::multiaddr::Protocol::Ip6(ip) if !ip.is_loopback() => {
                        Some(ip.to_string())
                    }
                    _ => None,
                });
                if let Some(ip) = ip_str {
                    info!("External IP from Identify: {ip}");
                    state.external_addr = Some(ip.clone());
                    emit_event(&**emit, &P2PEvent::ExternalAddr { address: ip });
                }
            }

            info!("Identified peer: {id_peer}");
        }

        // ---- Connection established ----
        SwarmEvent::ConnectionEstablished { peer_id: new_peer, num_established, .. } => {
            info!("Connected to peer: {new_peer} (total connections: {num_established})");
            let count = swarm.connected_peers().count();
            emit_event(&**emit, &P2PEvent::Status {
                connected: true,
                peer_id: my_peer_id.to_string(),
                peer_count: count,
            });
            if state.bootstrap_peers.contains(&new_peer) {
                info!("Bootstrap node connected: {new_peer}");
                emit_event(&**emit, &P2PEvent::BootstrapStatus { connected: true });

                // Trigger Kademlia bootstrap to populate routing table
                if let Err(e) = swarm.behaviour_mut().kademlia.bootstrap() {
                    warn!("Kademlia bootstrap failed: {e:?}");
                } else {
                    info!("Kademlia bootstrap initiated");
                }

                // Re-request relay reservation if behind NAT and no active reservation
                if state.nat_status == "private"
                    && !state.relay_reserved
                    && !state.relay_reservation_pending
                {
                    state.relay_reservation_pending = true;
                    // Build full relay addr with transport prefix
                    let relay_addr: Multiaddr = if let Some(transport) = state.bootstrap_addrs.get(&new_peer) {
                        let mut addr = transport.clone();
                        addr.push(libp2p::multiaddr::Protocol::P2p(new_peer));
                        addr.push(libp2p::multiaddr::Protocol::P2pCircuit);
                        addr
                    } else {
                        format!("/p2p/{new_peer}/p2p-circuit").parse().expect("valid relay multiaddr")
                    };
                    match swarm.listen_on(relay_addr.clone()) {
                        Ok(_) => info!("Requested relay reservation via reconnected bootstrap {new_peer} at {relay_addr}"),
                        Err(e) => warn!("Failed to listen on relay address: {e}"),
                    }
                    emit_event(&**emit, &P2PEvent::RelayStatus {
                        status: "reserving".to_string(),
                        relay_addr: None,
                    });
                }
            }
        }

        // ---- Connection closed ----
        SwarmEvent::ConnectionClosed { peer_id: dc_peer, num_established, cause, .. } => {
            let reason = cause.map_or_else(|| "none".to_string(), |e| format!("{e}"));
            info!("Disconnected from peer: {dc_peer} (remaining: {num_established}, cause: {reason})");

            if state.bootstrap_peers.contains(&dc_peer) && num_established == 0 {
                // Check if any other bootstrap peer is still connected
                let any_bootstrap_connected = state.bootstrap_peers.iter()
                    .any(|bp| *bp != dc_peer && swarm.is_connected(bp));
                if !any_bootstrap_connected {
                    info!("Bootstrap node disconnected: {dc_peer}");
                    emit_event(&**emit, &P2PEvent::BootstrapStatus { connected: false });

                    // Relay reservation is lost when bootstrap disconnects
                    if state.relay_reserved {
                        state.relay_reserved = false;
                        state.relay_reservation_pending = false;
                        emit_event(&**emit, &P2PEvent::RelayStatus {
                            status: "none".to_string(),
                            relay_addr: None,
                        });
                    }
                }
            }

            let pid = dc_peer.to_string();
            let nick = state.peer_nicknames
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| pid[..8.min(pid.len())].to_string());

            for (room, members) in state.room_members.iter_mut() {
                if members.remove(&pid) {
                    emit_event(&**emit, &P2PEvent::PeerLeft {
                        peer_id: pid.clone(),
                        nickname: nick.clone(),
                        room: room.clone(),
                    });
                }
            }

            // Clean up upload sessions for disconnected peer
            for evt in state.upload_tracker.remove_peer(&pid) {
                emit_event(&**emit, &evt);
            }

            // Remove disconnected peer from download provider sets and emit updated progress
            let changed = state.download_manager.remove_provider(&dc_peer);
            for hash in changed {
                if let Some(evt) = state.download_manager.progress_event(&hash) {
                    emit_event(&**emit, &evt);
                }
            }

            let count = swarm.connected_peers().count();
            emit_event(&**emit, &P2PEvent::Status {
                connected: count > 0,
                peer_id: my_peer_id.to_string(),
                peer_count: count,
            });
        }

        // ---- New listen address ----
        SwarmEvent::NewListenAddr { address, .. } => {
            let full_addr = format!("{}/p2p/{}", address, my_peer_id);
            info!("Listening on: {full_addr}");
            // Only emit non-loopback addresses to the hub for peer exchange
            if !is_loopback_multiaddr(&address) {
                emit_event(&**emit, &P2PEvent::ListenAddr { multiaddr: full_addr });
            }
        }

        // ---- AutoNAT: reachability status changed ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Autonat(autonat::Event::StatusChanged {
            old,
            new,
        })) => {
            let status_str = match &new {
                autonat::NatStatus::Public(_) => "public",
                autonat::NatStatus::Private => "private",
                autonat::NatStatus::Unknown => "unknown",
            };
            info!("NAT status changed: {:?} -> {:?}", old, new);
            state.nat_status = status_str.to_string();
            emit_event(&**emit, &P2PEvent::NatStatus {
                status: status_str.to_string(),
            });

            // Extract external address from Public status
            if let autonat::NatStatus::Public(addr) = &new {
                // addr is a Multiaddr like /ip4/1.2.3.4/tcp/12345
                // Extract just the IP part
                let ip_str = addr.iter().find_map(|p| match p {
                    libp2p::multiaddr::Protocol::Ip4(ip) => Some(ip.to_string()),
                    libp2p::multiaddr::Protocol::Ip6(ip) => Some(ip.to_string()),
                    _ => None,
                });
                if let Some(ip) = ip_str {
                    state.external_addr = Some(ip.clone());
                    emit_event(&**emit, &P2PEvent::ExternalAddr { address: ip });
                }
            }

            // When NAT is private, request relay reservation through bootstrap nodes
            if matches!(&new, autonat::NatStatus::Private) && !state.relay_reservation_pending {
                info!("NAT is private, requesting relay reservation via bootstrap nodes");
                state.relay_reservation_pending = true;
                for bp in &state.bootstrap_peers {
                    // Build full relay addr: /ip4/.../tcp/.../p2p/{relay}/p2p-circuit
                    let relay_addr: Multiaddr = if let Some(transport) = state.bootstrap_addrs.get(bp) {
                        let mut addr = transport.clone();
                        addr.push(libp2p::multiaddr::Protocol::P2p(*bp));
                        addr.push(libp2p::multiaddr::Protocol::P2pCircuit);
                        addr
                    } else {
                        format!("/p2p/{bp}/p2p-circuit").parse().expect("valid relay multiaddr")
                    };
                    match swarm.listen_on(relay_addr.clone()) {
                        Ok(_) => info!("Requested relay reservation via {bp} at {relay_addr}"),
                        Err(e) => warn!("Failed to listen on relay via {bp}: {e}"),
                    }
                }
                emit_event(&**emit, &P2PEvent::RelayStatus {
                    status: "reserving".to_string(),
                    relay_addr: None,
                });
            }
        }

        // ---- AutoNAT: probe events (for debugging) ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Autonat(event)) => {
            debug!("AutoNAT: {:?}", event);
        }

        // ---- Relay Client: reservation events ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::RelayClient(
            relay::client::Event::ReservationReqAccepted { relay_peer_id, .. }
        )) => {
            info!("Relay reservation accepted by {relay_peer_id}");
            state.relay_reserved = true;
            state.relay_reservation_pending = false;
            // Build full circuit address: /ip4/.../tcp/.../p2p/{relay}/p2p-circuit/p2p/{us}
            let addr = if let Some(transport) = state.bootstrap_addrs.get(&relay_peer_id) {
                format!("{transport}/p2p/{relay_peer_id}/p2p-circuit/p2p/{my_peer_id}")
            } else {
                format!("/p2p/{relay_peer_id}/p2p-circuit/p2p/{my_peer_id}")
            };
            // Register the relayed address as our external address so peers can find us
            if let Ok(circuit_addr) = addr.parse::<Multiaddr>() {
                swarm.add_external_address(circuit_addr);
                info!("Added external relay address: {addr}");
            }
            emit_event(&**emit, &P2PEvent::RelayStatus {
                status: "reserved".to_string(),
                relay_addr: Some(addr),
            });
        }

        SwarmEvent::Behaviour(NexusBehaviourEvent::RelayClient(event)) => {
            info!("Relay client: {:?}", event);
        }

        // ---- DCUtR: hole-punching events ----
        SwarmEvent::Behaviour(NexusBehaviourEvent::Dcutr(event)) => {
            match &event.result {
                Ok(_) => {
                    info!("DCUtR hole-punch succeeded with {}", event.remote_peer_id);
                    emit_event(&**emit, &P2PEvent::HolePunchStatus {
                        status: "succeeded".to_string(),
                        peer_id: event.remote_peer_id.to_string(),
                    });
                }
                Err(e) => {
                    warn!("DCUtR hole-punch failed with {}: {e}", event.remote_peer_id);
                    emit_event(&**emit, &P2PEvent::HolePunchStatus {
                        status: "failed".to_string(),
                        peer_id: event.remote_peer_id.to_string(),
                    });
                }
            }
        }

        _ => {}
    }
}

/// Send a DownloadNotify to all providers of a download.
fn notify_providers(
    providers: &[PeerId],
    content_hash: &str,
    status: &str,
    swarm: &mut Swarm<NexusBehaviour>,
) {
    for peer in providers {
        swarm
            .behaviour_mut()
            .file_transfer
            .send_request(peer, FileRequest::DownloadNotify {
                content_hash: content_hash.to_string(),
                status: status.to_string(),
            });
    }
}

/// Read a single chunk from a file on disk.
fn read_chunk_from_disk(path: &std::path::Path, chunk_index: u32) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let offset = chunk_index as u64 * CHUNK_SIZE as u64;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;

    // Use take() + read_to_end() to reliably read up to CHUNK_SIZE bytes
    // (a single read() call may not return the full 4MB on some systems)
    let mut buf = Vec::with_capacity(CHUNK_SIZE);
    file.take(CHUNK_SIZE as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}
