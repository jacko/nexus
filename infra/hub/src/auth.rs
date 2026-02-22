use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub fn derive_user_id(public_key_hex: &str) -> Option<String> {
    let bytes = hex::decode(public_key_hex).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hasher.finalize();
    Some(hex::encode(&hash[..8])) // 16 hex chars
}

pub fn verify_signature(public_key_hex: &str, message: &[u8], signature_hex: &str) -> bool {
    let Ok(pubkey_bytes) = hex::decode(public_key_hex) else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(signature_hex) else {
        return false;
    };

    let pubkey_array: [u8; 32] = match pubkey_bytes.try_into() {
        Ok(arr) => arr,
        Err(_) => return false,
    };

    let Ok(verifying_key) = VerifyingKey::from_bytes(&pubkey_array) else {
        return false;
    };

    let Ok(signature) = Signature::from_slice(&sig_bytes) else {
        return false;
    };

    verifying_key.verify_strict(message, &signature).is_ok()
}
