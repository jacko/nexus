use async_trait::async_trait;
use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::request_response;
use libp2p::StreamProtocol;
use serde::{Deserialize, Serialize};

use crate::files::merkle::MerkleProof;

/// Protocol identifier for file transfers.
pub fn file_protocol() -> StreamProtocol {
    StreamProtocol::new("/nexus/file/1.0.0")
}

/// Requests for the file transfer protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FileRequest {
    /// Request file metadata (size, chunk count, merkle root).
    Metadata { content_hash: String },
    /// Request a specific chunk with its Merkle proof.
    Chunk {
        content_hash: String,
        chunk_index: u32,
    },
    /// Notify provider that this download was paused, cancelled, or completed.
    DownloadNotify {
        content_hash: String,
        /// "paused", "cancelled", or "completed"
        status: String,
    },
}

/// Responses for the file transfer protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FileResponse {
    /// File metadata.
    Metadata {
        content_hash: String,
        size: u64,
        chunk_count: u32,
        merkle_root: String,
        /// Hex-encoded BLAKE3 hash of each chunk (for resumable download verification).
        chunk_hashes: Vec<String>,
    },
    /// A chunk of file data with Merkle proof.
    Chunk {
        content_hash: String,
        chunk_index: u32,
        #[serde(skip)]
        data: Vec<u8>,
        proof: MerkleProof,
    },
    /// The requested hash was not found.
    NotFound { content_hash: String },
    /// Acknowledgement (used as response to DownloadNotify).
    Ack,
}

/// Codec for the file transfer protocol.
///
/// Wire format uses a hybrid approach for efficiency:
/// - Tag byte `0` + 4-byte length + JSON: for requests, Metadata, NotFound (small messages)
/// - Tag byte `1` + 4-byte header length + JSON header + raw chunk bytes: for Chunk responses
///
/// This avoids serializing 1MB chunks as JSON arrays (which would be ~3.7MB)
/// and instead sends raw binary data with ~0% overhead.
#[derive(Debug, Clone, Default)]
pub struct FileCodec;

/// Max size for JSON-only messages (metadata, requests, not-found).
const MAX_JSON_MSG_SIZE: usize = 512 * 1024; // 512KB — plenty for metadata + chunk hashes

/// Max total size for binary chunk messages (header + raw data).
const MAX_CHUNK_MSG_SIZE: usize = 5 * 1024 * 1024; // 5MB — 4MB chunk + header overhead

/// JSON header for binary chunk wire format (excludes the raw data).
#[derive(Serialize, Deserialize)]
struct ChunkHeader {
    content_hash: String,
    chunk_index: u32,
    proof: MerkleProof,
}

// Wire format tags
const TAG_JSON: u8 = 0;
const TAG_BINARY_CHUNK: u8 = 1;

#[async_trait]
impl request_response::Codec for FileCodec {
    type Protocol = StreamProtocol;
    type Request = FileRequest;
    type Response = FileResponse;

    async fn read_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        // Requests are always JSON (tag 0)
        let tag = read_u8(io).await?;
        if tag != TAG_JSON {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unexpected request tag: {}", tag),
            ));
        }
        read_length_prefixed_json(io, MAX_JSON_MSG_SIZE).await
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Response>
    where
        T: AsyncRead + Unpin + Send,
    {
        let tag = read_u8(io).await?;
        match tag {
            TAG_JSON => {
                // Metadata or NotFound — standard JSON
                read_length_prefixed_json(io, MAX_JSON_MSG_SIZE).await
            }
            TAG_BINARY_CHUNK => {
                // Chunk: header_len(4) + header_json + raw_data_len(4) + raw_data
                let header_len = read_u32(io).await? as usize;
                if header_len > MAX_JSON_MSG_SIZE {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "chunk header too large",
                    ));
                }
                let mut header_buf = vec![0u8; header_len];
                io.read_exact(&mut header_buf).await?;
                let header: ChunkHeader = serde_json::from_slice(&header_buf)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

                let data_len = read_u32(io).await? as usize;
                if data_len > MAX_CHUNK_MSG_SIZE {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "chunk data too large",
                    ));
                }
                let mut data = vec![0u8; data_len];
                io.read_exact(&mut data).await?;

                Ok(FileResponse::Chunk {
                    content_hash: header.content_hash,
                    chunk_index: header.chunk_index,
                    data,
                    proof: header.proof,
                })
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown response tag: {}", tag),
            )),
        }
    }

    async fn write_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        req: Self::Request,
    ) -> std::io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        // Requests are always JSON
        io.write_all(&[TAG_JSON]).await?;
        write_length_prefixed_json(io, &req).await
    }

    async fn write_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        resp: Self::Response,
    ) -> std::io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        match resp {
            FileResponse::Chunk {
                content_hash,
                chunk_index,
                data,
                proof,
            } => {
                // Binary chunk format: tag(1) + header_len(4) + header_json + data_len(4) + raw_data
                let header = ChunkHeader {
                    content_hash,
                    chunk_index,
                    proof,
                };
                let header_json = serde_json::to_vec(&header)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

                io.write_all(&[TAG_BINARY_CHUNK]).await?;
                io.write_all(&(header_json.len() as u32).to_be_bytes())
                    .await?;
                io.write_all(&header_json).await?;
                io.write_all(&(data.len() as u32).to_be_bytes()).await?;
                io.write_all(&data).await?;
                Ok(())
            }
            other => {
                // Metadata and NotFound — standard JSON
                io.write_all(&[TAG_JSON]).await?;
                write_length_prefixed_json(io, &other).await
            }
        }
    }
}

async fn read_u8<T: AsyncRead + Unpin + Send>(io: &mut T) -> std::io::Result<u8> {
    let mut buf = [0u8; 1];
    io.read_exact(&mut buf).await?;
    Ok(buf[0])
}

async fn read_u32<T: AsyncRead + Unpin + Send>(io: &mut T) -> std::io::Result<u32> {
    let mut buf = [0u8; 4];
    io.read_exact(&mut buf).await?;
    Ok(u32::from_be_bytes(buf))
}

async fn read_length_prefixed_json<T, D>(io: &mut T, max_size: usize) -> std::io::Result<D>
where
    T: AsyncRead + Unpin + Send,
    D: serde::de::DeserializeOwned,
{
    let len = read_u32(io).await? as usize;
    if len > max_size {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("message too large: {} > {}", len, max_size),
        ));
    }
    let mut buf = vec![0u8; len];
    io.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

async fn write_length_prefixed_json<T, S>(io: &mut T, value: &S) -> std::io::Result<()>
where
    T: AsyncWrite + Unpin + Send,
    S: Serialize,
{
    let data = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let len = (data.len() as u32).to_be_bytes();
    io.write_all(&len).await?;
    io.write_all(&data).await?;
    Ok(())
}
