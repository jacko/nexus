use serde::{Deserialize, Serialize};

/// Info about an indexed file, sent with IndexComplete so the UI can map content hashes to paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFileInfo {
    pub content_hash: String,
    pub relative_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum P2PEvent {
    Status {
        connected: bool,
        peer_id: String,
        peer_count: usize,
    },
    Message {
        room: String,
        sender: String,
        nickname: String,
        text: String,
        timestamp: u64,
    },
    DirectMessage {
        sender: String,
        nickname: String,
        text: String,
        timestamp: u64,
    },
    PeerJoined {
        peer_id: String,
        nickname: String,
        room: String,
    },
    PeerLeft {
        peer_id: String,
        nickname: String,
        room: String,
    },
    Error {
        message: String,
    },
    /// A new listen address was established.
    ListenAddr {
        multiaddr: String,
    },
    /// File indexing progress.
    IndexProgress {
        folder: String,
        files_scanned: u32,
        files_total: u32,
        current_file: String,
    },
    /// File indexing complete for a folder.
    IndexComplete {
        folder: String,
        file_count: u32,
        files: Vec<IndexedFileInfo>,
    },
    /// Download progress update.
    DownloadProgress {
        content_hash: String,
        file_name: String,
        status: String,
        chunks_received: u32,
        chunks_total: u32,
        bytes_downloaded: u64,
        bytes_total: u64,
        speed_bps: u64,
        providers: usize,
    },
    /// Download completed successfully.
    DownloadComplete {
        content_hash: String,
        file_name: String,
        save_path: String,
        size: u64,
    },
    /// Download failed.
    DownloadError {
        content_hash: String,
        file_name: String,
        message: String,
    },
    /// Upload progress — we are serving chunks to a peer.
    UploadProgress {
        content_hash: String,
        file_name: String,
        peer_id: String,
        nickname: String,
        chunks_served: u32,
        chunks_total: u32,
        bytes_sent: u64,
        bytes_total: u64,
        speed_bps: u64,
    },
    /// Upload complete — peer has received all chunks.
    UploadComplete {
        content_hash: String,
        file_name: String,
        peer_id: String,
        nickname: String,
        bytes_total: u64,
    },
    /// NAT reachability status determined by AutoNAT.
    NatStatus {
        /// "public", "private", or "unknown"
        status: String,
    },
    /// Our externally-observed IP address (from AutoNAT or Identify).
    ExternalAddr {
        address: String,
    },
    /// Connection status to a bootstrap (discovery) node.
    BootstrapStatus {
        connected: bool,
    },
    /// Relay reservation status (for NAT traversal).
    RelayStatus {
        /// "none", "reserving", "reserved", "failed"
        status: String,
        /// Relayed multiaddr if reserved.
        relay_addr: Option<String>,
    },
    /// DCUtR hole-punch result.
    HolePunchStatus {
        /// "succeeded" or "failed"
        status: String,
        /// The peer we attempted hole-punching with.
        peer_id: String,
    },
}

impl P2PEvent {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!(r#"{{"type":"Error","data":{{"message":"serialize error: {}"}}}}"#, e)
        })
    }
}
