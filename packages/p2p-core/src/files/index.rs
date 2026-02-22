use crate::files::cache::{CachedEntry, FileIndexCache};
use crate::files::merkle::{Hash, MerkleTree};
use crate::files::CHUNK_SIZE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Metadata for a single indexed file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Absolute path on disk.
    pub path: PathBuf,
    /// File size in bytes.
    pub size: u64,
    /// Hex-encoded BLAKE3 hash of the entire file.
    pub content_hash: String,
    /// Hex-encoded Merkle root of chunk hashes.
    pub merkle_root: String,
    /// Number of chunks (each up to CHUNK_SIZE).
    pub chunk_count: u32,
    /// Relative path from the shared folder root (for remote display).
    pub relative_path: String,
}

/// Progress of a folder scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub folder: String,
    pub files_scanned: u32,
    pub files_total: u32,
    pub current_file: String,
}

/// In-memory index of all shared files.
#[derive(Debug, Clone, Default)]
pub struct FileIndex {
    /// content_hash (hex) → FileEntry
    pub by_hash: HashMap<String, FileEntry>,
    /// content_hash (hex) → MerkleTree (not serialized)
    merkle_trees: HashMap<String, MerkleTree>,
}

impl FileIndex {
    /// Scan a directory with cache support. Files whose size+mtime match
    /// a cache entry are skipped (no re-hashing). Returns updated cache entries
    /// alongside the normal entries/trees.
    ///
    /// This is a blocking operation — call from `spawn_blocking`.
    pub fn scan_folder(
        root: &Path,
        cache: &FileIndexCache,
        on_progress: impl Fn(ScanProgress),
    ) -> Result<(Vec<FileEntry>, Vec<(String, MerkleTree)>, Vec<CachedEntry>), String> {
        let file_paths = collect_files(root)?;
        let total = file_paths.len() as u32;
        let folder = root.display().to_string();

        let mut entries = Vec::with_capacity(file_paths.len());
        let mut trees = Vec::with_capacity(file_paths.len());
        let mut new_cache_entries = Vec::with_capacity(file_paths.len());

        for (i, file_path) in file_paths.iter().enumerate() {
            let relative = file_path
                .strip_prefix(root)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();

            on_progress(ScanProgress {
                folder: folder.clone(),
                files_scanned: i as u32,
                files_total: total,
                current_file: relative.clone(),
            });

            let meta = match fs::metadata(file_path) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("Failed to stat {}: {}", file_path.display(), e);
                    continue;
                }
            };
            let size = meta.len();
            let mtime_secs = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            // Check cache
            if let Some(cached) = cache.get_if_valid(file_path, size, mtime_secs) {
                if let Some(tree) = cached.to_merkle_tree() {
                    let entry = FileEntry {
                        path: file_path.clone(),
                        size: cached.size,
                        content_hash: cached.content_hash.clone(),
                        merkle_root: cached.merkle_root.clone(),
                        chunk_count: cached.chunk_count,
                        relative_path: relative,
                    };
                    trees.push((entry.content_hash.clone(), tree));
                    new_cache_entries.push(cached.clone());
                    entries.push(entry);
                    continue;
                }
            }

            // Cache miss — hash the file
            match hash_file(file_path) {
                Ok((raw_entry, chunk_hashes_raw, tree)) => {
                    let entry = FileEntry {
                        path: file_path.clone(),
                        size: raw_entry.size,
                        content_hash: raw_entry.content_hash.clone(),
                        merkle_root: raw_entry.merkle_root.clone(),
                        chunk_count: raw_entry.chunk_count,
                        relative_path: relative,
                    };

                    // Build cache entry
                    new_cache_entries.push(CachedEntry {
                        path: file_path.to_string_lossy().to_string(),
                        size,
                        mtime_secs,
                        content_hash: entry.content_hash.clone(),
                        merkle_root: entry.merkle_root.clone(),
                        chunk_count: entry.chunk_count,
                        chunk_hashes: chunk_hashes_raw.iter().map(hex::encode).collect(),
                    });

                    trees.push((entry.content_hash.clone(), tree));
                    entries.push(entry);
                }
                Err(e) => {
                    tracing::warn!("Failed to hash {}: {}", file_path.display(), e);
                }
            }
        }

        on_progress(ScanProgress {
            folder,
            files_scanned: total,
            files_total: total,
            current_file: String::new(),
        });

        Ok((entries, trees, new_cache_entries))
    }

    /// Add entries from a scan to the index.
    pub fn add_entries(&mut self, entries: Vec<FileEntry>, trees: Vec<(String, MerkleTree)>) {
        for entry in entries {
            self.by_hash.insert(entry.content_hash.clone(), entry);
        }
        for (hash, tree) in trees {
            self.merkle_trees.insert(hash, tree);
        }
    }

    /// Remove all entries whose paths start with the given folder.
    pub fn remove_folder(&mut self, folder: &Path) {
        let hashes_to_remove: Vec<String> = self
            .by_hash
            .iter()
            .filter(|(_, e)| e.path.starts_with(folder))
            .map(|(h, _)| h.clone())
            .collect();

        for hash in hashes_to_remove {
            self.by_hash.remove(&hash);
            self.merkle_trees.remove(&hash);
        }
    }

    /// Look up a file by its content hash.
    pub fn get(&self, content_hash: &str) -> Option<&FileEntry> {
        self.by_hash.get(content_hash)
    }

    /// Get the Merkle tree for a file.
    pub fn get_tree(&self, content_hash: &str) -> Option<&MerkleTree> {
        self.merkle_trees.get(content_hash)
    }

    /// Get all content hashes (for DHT PROVIDE announcements).
    pub fn all_hashes(&self) -> Vec<String> {
        self.by_hash.keys().cloned().collect()
    }
}

/// Recursively collect all file paths in a directory, skipping hidden files and symlinks.
fn collect_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_recursive(dir, &mut files, 10)?;
    Ok(files)
}

fn collect_files_recursive(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) -> Result<(), String> {
    if depth == 0 {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip hidden files/folders
        if name_str.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Skip symlinks
        if meta.is_symlink() {
            continue;
        }

        if meta.is_dir() {
            collect_files_recursive(&path, out, depth - 1)?;
        } else if meta.is_file() && meta.len() > 0 {
            out.push(path);
        }
    }

    Ok(())
}

/// Hash a file: compute full BLAKE3 hash and per-chunk hashes, build Merkle tree.
/// Returns (FileEntry, raw_chunk_hashes, MerkleTree).
fn hash_file(path: &Path) -> Result<(FileEntry, Vec<Hash>, MerkleTree), String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;

    let meta = file
        .metadata()
        .map_err(|e| format!("metadata {}: {}", path.display(), e))?;
    let size = meta.len();

    let mut full_hasher = blake3::Hasher::new();
    let mut chunk_hashes: Vec<Hash> = Vec::new();
    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        let bytes_read = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {}", path.display(), e))?;

        if bytes_read == 0 {
            break;
        }

        let chunk_data = &buf[..bytes_read];
        full_hasher.update(chunk_data);
        chunk_hashes.push(*blake3::hash(chunk_data).as_bytes());
    }

    // Handle empty file edge case (shouldn't happen since we filter size > 0)
    if chunk_hashes.is_empty() {
        chunk_hashes.push(*blake3::hash(&[]).as_bytes());
    }

    let content_hash = hex::encode(full_hasher.finalize().as_bytes());
    let tree = MerkleTree::from_leaves(chunk_hashes.clone());
    let merkle_root = hex::encode(tree.root());
    let chunk_count = ((size + CHUNK_SIZE as u64 - 1) / CHUNK_SIZE as u64) as u32;

    let entry = FileEntry {
        path: path.to_path_buf(),
        size,
        content_hash,
        merkle_root,
        chunk_count,
        relative_path: String::new(), // filled in by caller
    };

    Ok((entry, chunk_hashes, tree))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hash_file_basic() {
        let dir = std::env::temp_dir().join("nexus_test_hash");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let file_path = dir.join("test.txt");
        let mut f = fs::File::create(&file_path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let (entry, _chunk_hashes, tree) = hash_file(&file_path).unwrap();
        assert_eq!(entry.size, 11);
        assert_eq!(entry.chunk_count, 1);
        assert!(!entry.content_hash.is_empty());
        assert_eq!(entry.content_hash.len(), 64); // hex of 32 bytes

        // Verify Merkle proof for the single chunk
        let root = tree.root();
        let proof = tree.proof(0);
        let chunk_hash = *blake3::hash(b"hello world").as_bytes();
        assert!(MerkleTree::verify(&root, &chunk_hash, &proof));

        let _ = fs::remove_dir_all(&dir);
    }
}
