use libp2p::identity::Keypair;
use std::fs;
use std::path::Path;

/// Load an Ed25519 keypair from disk, or generate a new one and save it.
pub fn load_or_generate_keypair(path: Option<&str>) -> Keypair {
    if let Some(path) = path {
        let path = Path::new(path);
        if path.exists() {
            let bytes = fs::read(path).expect("failed to read identity file");
            Keypair::ed25519_from_bytes(bytes).expect("invalid ed25519 key")
        } else {
            let keypair = Keypair::generate_ed25519();
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok();
            }
            if let Ok(ed25519_kp) = keypair.clone().try_into_ed25519() {
                fs::write(path, ed25519_kp.secret().as_ref()).ok();
            }
            keypair
        }
    } else {
        Keypair::generate_ed25519()
    }
}
