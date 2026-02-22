use async_trait::async_trait;
use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use libp2p::request_response;
use libp2p::StreamProtocol;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Wire format for direct messages via Request-Response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectMessage {
    pub sender: String,
    pub nickname: String,
    pub text: String,
    pub timestamp: u64,
}

impl DirectMessage {
    pub fn new(sender: &str, nickname: &str, text: &str) -> Self {
        Self {
            sender: sender.into(),
            nickname: nickname.into(),
            text: text.into(),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        }
    }
}

/// Response to a DM (acknowledgement).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmResponse {
    pub accepted: bool,
}

/// JSON codec for the DM request-response protocol.
#[derive(Debug, Clone, Default)]
pub struct DmCodec;

/// Protocol identifier for DMs.
pub fn dm_protocol() -> StreamProtocol {
    StreamProtocol::new("/nexus/dm/1.0.0")
}

#[async_trait]
impl request_response::Codec for DmCodec {
    type Protocol = StreamProtocol;
    type Request = DirectMessage;
    type Response = DmResponse;

    async fn read_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_length_prefixed_json(io).await
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> std::io::Result<Self::Response>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_length_prefixed_json(io).await
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
        write_length_prefixed_json(io, &resp).await
    }
}

async fn read_length_prefixed_json<T, D>(io: &mut T) -> std::io::Result<D>
where
    T: AsyncRead + Unpin + Send,
    D: serde::de::DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    io.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 65536 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut buf = vec![0u8; len];
    io.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

async fn write_length_prefixed_json<T, S>(io: &mut T, value: &S) -> std::io::Result<()>
where
    T: AsyncWrite + Unpin + Send,
    S: Serialize,
{
    let data =
        serde_json::to_vec(value).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let len = (data.len() as u32).to_be_bytes();
    io.write_all(&len).await?;
    io.write_all(&data).await?;
    Ok(())
}
