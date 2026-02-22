use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct P2PConfig {
    /// Port to listen on (0 = random)
    pub listen_port: u16,
    /// Bootstrap node multiaddresses (e.g. "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooW...")
    pub bootstrap_peers: Vec<String>,
    /// User's chosen nickname
    pub nickname: String,
    /// Path to persist the Ed25519 identity keypair
    pub identity_path: Option<String>,
}
