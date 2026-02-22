use crate::auth;
use crate::state::HubState;
use axum::extract::{Multipart, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use image::imageops::FilterType;
use image::ImageFormat;
use serde_json::{json, Value};
use std::io::Cursor;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

const MAX_TIMESTAMP_AGE_MS: u64 = 30_000;
const MAX_FILE_SIZE: usize = 10 * 1024 * 1024; // 10 MB

/// Extract and verify auth headers: X-Public-Key, X-Timestamp, X-Signature
fn authenticate(headers: &HeaderMap) -> Result<String, (StatusCode, String)> {
    let public_key = headers
        .get("X-Public-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Public-Key".into()))?;

    let timestamp_str = headers
        .get("X-Timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Timestamp".into()))?;

    let signature = headers
        .get("X-Signature")
        .and_then(|v| v.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing X-Signature".into()))?;

    // Verify timestamp is recent
    let timestamp_ms: u64 = timestamp_str
        .parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid timestamp".into()))?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    if now_ms.saturating_sub(timestamp_ms) > MAX_TIMESTAMP_AGE_MS {
        return Err((StatusCode::UNAUTHORIZED, "Timestamp too old".into()));
    }

    // Verify signature over timestamp bytes
    let timestamp_bytes = timestamp_str.as_bytes();
    if !auth::verify_signature(public_key, timestamp_bytes, signature) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid signature".into()));
    }

    // Derive user_id
    auth::derive_user_id(public_key)
        .ok_or((StatusCode::BAD_REQUEST, "Invalid public key".into()))
}

/// POST /api/avatar — multipart upload with image processing
pub async fn upload(
    State(hub): State<HubState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user_id = authenticate(&headers)?;

    // Read multipart file field
    let mut image_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("Read error: {e}")))?;
            if data.len() > MAX_FILE_SIZE {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "File too large (max 10MB)".into()));
            }
            image_bytes = Some(data.to_vec());
            break;
        }
    }

    let image_bytes =
        image_bytes.ok_or((StatusCode::BAD_REQUEST, "No 'file' field in upload".into()))?;

    // Decode image
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid image: {e}")))?;

    // Center-crop to square
    let (w, h) = (img.width(), img.height());
    let side = w.min(h);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    let cropped = img.crop_imm(x, y, side, side);

    // Resize to 256x256 and 128x128
    let img_256 = cropped.resize_exact(256, 256, FilterType::Lanczos3);
    let img_128 = cropped.resize_exact(128, 128, FilterType::Lanczos3);

    // Encode as WebP
    let avatars_dir = Path::new(&hub.data_dir).join("avatars");
    std::fs::create_dir_all(&avatars_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Dir error: {e}")))?;

    let path_256 = avatars_dir.join(format!("{user_id}_256.webp"));
    let path_128 = avatars_dir.join(format!("{user_id}_128.webp"));

    let mut buf_256 = Cursor::new(Vec::new());
    img_256
        .write_to(&mut buf_256, ImageFormat::WebP)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Encode error: {e}")))?;
    std::fs::write(&path_256, buf_256.into_inner())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Write error: {e}")))?;

    let mut buf_128 = Cursor::new(Vec::new());
    img_128
        .write_to(&mut buf_128, ImageFormat::WebP)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Encode error: {e}")))?;
    std::fs::write(&path_128, buf_128.into_inner())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Write error: {e}")))?;

    info!("Avatar uploaded for user {user_id}");

    Ok(Json(json!({
        "url": format!("/avatars/{user_id}_256.webp")
    })))
}

/// DELETE /api/avatar — remove avatar files
pub async fn remove(
    State(hub): State<HubState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let user_id = authenticate(&headers)?;

    let avatars_dir = Path::new(&hub.data_dir).join("avatars");
    let path_256 = avatars_dir.join(format!("{user_id}_256.webp"));
    let path_128 = avatars_dir.join(format!("{user_id}_128.webp"));

    if path_256.exists() {
        std::fs::remove_file(&path_256).ok();
    }
    if path_128.exists() {
        std::fs::remove_file(&path_128).ok();
    }

    info!("Avatar removed for user {user_id}");

    Ok(Json(json!({ "ok": true })))
}
