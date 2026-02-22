pub mod merkle;
pub mod index;
pub mod download;
pub mod cache;

/// Chunk size for file transfers: 4MB
/// Larger chunks reduce per-chunk overhead (Merkle proofs, round-trips).
/// 16 concurrent × 4MB = 64MB max in-flight memory.
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
