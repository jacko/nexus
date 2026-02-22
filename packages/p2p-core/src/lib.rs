use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use tokio::sync::Mutex;

mod config;
mod events;
pub mod files;
mod identity;
mod node;
mod protocol;

use config::P2PConfig;
use node::{NodeCommand, P2PNodeInner};

#[napi]
pub struct NexusNode {
    inner: Arc<Mutex<Option<P2PNodeInner>>>,
}

#[napi]
impl NexusNode {
    #[napi(constructor)]
    pub fn new() -> Self {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::from_default_env()
                    .add_directive("p2p_core=info".parse().unwrap()),
            )
            .try_init()
            .ok();

        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Start the P2P node. The callback receives JSON-encoded P2PEvent objects.
    #[napi]
    pub async fn start(
        &self,
        config: P2PConfig,
        #[napi(ts_arg_type = "(event: string) => void")]
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> Result<String> {
        let node = P2PNodeInner::start(config, move |event_json| {
            callback.call(event_json, ThreadsafeFunctionCallMode::NonBlocking);
        })
        .await
        .map_err(|e| Error::from_reason(e))?;

        let peer_id = node.peer_id.to_string();
        *self.inner.lock().await = Some(node);
        Ok(peer_id)
    }

    #[napi]
    pub async fn join_room(&self, room: String) -> Result<()> {
        self.send_cmd(NodeCommand::JoinRoom { room }).await
    }

    #[napi]
    pub async fn leave_room(&self, room: String) -> Result<()> {
        self.send_cmd(NodeCommand::LeaveRoom { room }).await
    }

    #[napi]
    pub async fn send_message(&self, room: String, text: String) -> Result<()> {
        self.send_cmd(NodeCommand::SendMessage { room, text }).await
    }

    #[napi]
    pub async fn send_dm(&self, peer_id: String, text: String) -> Result<()> {
        self.send_cmd(NodeCommand::SendDm { peer_id, text }).await
    }

    #[napi]
    pub async fn set_nickname(&self, nickname: String) -> Result<()> {
        self.send_cmd(NodeCommand::SetNickname { nickname }).await
    }

    #[napi]
    pub async fn get_peers(&self) -> Result<()> {
        self.send_cmd(NodeCommand::GetPeers).await
    }

    #[napi]
    pub async fn index_folder(&self, folder_path: String) -> Result<()> {
        self.send_cmd(NodeCommand::IndexFolder { path: folder_path }).await
    }

    #[napi]
    pub async fn get_file_index(&self) -> Result<()> {
        self.send_cmd(NodeCommand::GetFileIndex).await
    }

    #[napi]
    pub async fn start_download(
        &self,
        content_hash: String,
        file_name: String,
        save_path: String,
    ) -> Result<()> {
        self.send_cmd(NodeCommand::StartDownload {
            content_hash,
            file_name,
            save_path,
        })
        .await
    }

    #[napi]
    pub async fn pause_download(&self, content_hash: String) -> Result<()> {
        self.send_cmd(NodeCommand::PauseDownload { content_hash }).await
    }

    #[napi]
    pub async fn resume_download(&self, content_hash: String) -> Result<()> {
        self.send_cmd(NodeCommand::ResumeDownload { content_hash }).await
    }

    #[napi]
    pub async fn cancel_download(&self, content_hash: String) -> Result<()> {
        self.send_cmd(NodeCommand::CancelDownload { content_hash }).await
    }

    #[napi]
    pub async fn get_active_downloads(&self) -> Result<()> {
        self.send_cmd(NodeCommand::GetActiveDownloads).await
    }

    #[napi]
    pub async fn add_peer(&self, multiaddr: String) -> Result<()> {
        self.send_cmd(NodeCommand::AddPeer { multiaddr }).await
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let guard = self.inner.lock().await;
        if let Some(node) = guard.as_ref() {
            node.cmd_tx.send(NodeCommand::Shutdown).await.ok();
        }
        Ok(())
    }
}

impl NexusNode {
    async fn send_cmd(&self, cmd: NodeCommand) -> Result<()> {
        let guard = self.inner.lock().await;
        let node = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("Node not started"))?;
        node.cmd_tx
            .send(cmd)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to send command: {e}")))
    }
}
