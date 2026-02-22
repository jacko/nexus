use crate::files::merkle::{Hash, MerkleTree};
use crate::files::index::FileEntry;
use crate::files::CHUNK_SIZE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A cached entry for a single file. Stores enough info to skip re-hashing
/// if the file hasn't changed (same size + mtime).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedEntry {
    /// Absolute path on disk.
    pub path: String,
    /// File size in bytes.
    pub size: u64,
    /// Modification time as seconds since Unix epoch.
    pub mtime_secs: i64,
    /// Hex-encoded BLAKE3 hash of the full file.
    pub content_hash: String,
    /// Hex-encoded Merkle root.
    pub merkle_root: String,
    /// Number of chunks.
    pub chunk_count: u32,
    /// Hex-encoded chunk hashes (leaves of the Merkle tree).
    pub chunk_hashes: Vec<String>,
}

impl CachedEntry {
    /// Rebuild a MerkleTree from the cached chunk hashes.
    pub fn to_merkle_tree(&self) -> Option<MerkleTree> {
        let leaves: Vec<Hash> = self
            .chunk_hashes
            .iter()
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

        if leaves.is_empty() || leaves.len() != self.chunk_hashes.len() {
            return None;
        }

        Some(MerkleTree::from_leaves(leaves))
    }

    /// Convert to a FileEntry (relative_path must be filled in by the caller).
    pub fn to_file_entry(&self) -> FileEntry {
        FileEntry {
            path: PathBuf::from(&self.path),
            size: self.size,
            content_hash: self.content_hash.clone(),
            merkle_root: self.merkle_root.clone(),
            chunk_count: self.chunk_count,
            relative_path: String::new(),
        }
    }
}

/// Persistent file index cache. Keyed by absolute file path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexCache {
    /// Chunk size used when this cache was built. If it changes, all entries are invalid.
    #[serde(default)]
    pub chunk_size: usize,
    pub entries: HashMap<String, CachedEntry>,
}

impl Default for FileIndexCache {
    fn default() -> Self {
        Self {
            chunk_size: CHUNK_SIZE,
            entries: HashMap::new(),
        }
    }
}

impl FileIndexCache {
    /// Load cache from a JSON file, returning an empty cache on any error
    /// or if the chunk size has changed.
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(data) => {
                let cache: Self = serde_json::from_str(&data).unwrap_or_default();
                if cache.chunk_size != CHUNK_SIZE {
                    tracing::info!(
                        "Cache chunk size changed ({} -> {}), invalidating",
                        cache.chunk_size, CHUNK_SIZE
                    );
                    return Self::default();
                }
                cache
            }
            Err(_) => Self::default(),
        }
    }

    /// Save cache to a JSON file.
    pub fn save(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        if let Ok(data) = serde_json::to_string(self) {
            fs::write(path, data).ok();
        }
    }

    /// Check if a file has a valid cache entry (same size and mtime).
    pub fn get_if_valid(&self, file_path: &Path, size: u64, mtime_secs: i64) -> Option<&CachedEntry> {
        let key = file_path.to_string_lossy().to_string();
        self.entries.get(&key).filter(|e| e.size == size && e.mtime_secs == mtime_secs)
    }

    /// Insert or update a cache entry.
    pub fn insert(&mut self, entry: CachedEntry) {
        self.entries.insert(entry.path.clone(), entry);
    }

    /// Remove entries whose paths start with the given folder
    /// (used when a folder is removed from shares).
    pub fn remove_folder(&mut self, folder: &Path) {
        let prefix = folder.to_string_lossy().to_string();
        self.entries.retain(|k, _| !k.starts_with(&prefix));
    }
}
