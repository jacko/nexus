use crate::auth;
use crate::state::{HubState, UserSession};
use rand::Rng;
use serde::{Deserialize, Serialize};
use socketioxide::extract::{Data, SocketRef, State};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

// ---- Payloads ----

#[derive(Debug, Deserialize)]
pub struct AuthData {
    pub nickname: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    signature: String,
}

#[derive(Debug, Deserialize)]
struct JoinRoomData {
    room: String,
}

#[derive(Debug, Deserialize)]
struct LeaveRoomData {
    room: String,
}

#[derive(Debug, Deserialize)]
struct MessageData {
    room: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct DmData {
    #[serde(rename = "targetId")]
    target_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct SetNicknameData {
    nickname: String,
}

#[derive(Debug, Deserialize)]
struct FileListRequestData {
    #[serde(rename = "targetId")]
    target_id: String,
}

#[derive(Debug, Deserialize)]
struct FileListResponseData {
    #[serde(rename = "requesterId")]
    requester_id: String,
    data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    #[serde(rename = "userId")]
    user_id: String,
    nickname: String,
    #[serde(rename = "peerCount")]
    peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct MessagePayload {
    room: String,
    sender: String,
    nickname: String,
    text: String,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DmPayload {
    sender: String,
    nickname: String,
    text: String,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
struct PeerEventPayload {
    #[serde(rename = "userId")]
    user_id: String,
    nickname: String,
    room: String,
    #[serde(rename = "hasAvatar")]
    has_avatar: bool,
}

#[derive(Debug, Clone, Serialize)]
struct HistoryPayload {
    room: String,
    messages: Vec<HistoryMessage>,
}

#[derive(Debug, Clone, Serialize)]
struct HistoryMessage {
    sender: String,
    nickname: String,
    text: String,
    timestamp: u64,
    #[serde(rename = "hasAvatar")]
    has_avatar: bool,
}

#[derive(Debug, Clone, Serialize)]
struct MemberListPayload {
    room: String,
    members: Vec<MemberInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct MemberInfo {
    #[serde(rename = "userId")]
    user_id: String,
    nickname: String,
    #[serde(rename = "hasAvatar")]
    has_avatar: bool,
}

#[derive(Debug, Clone, Serialize)]
struct NicknameChangedPayload {
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "oldNickname")]
    old_nickname: String,
    #[serde(rename = "newNickname")]
    new_nickname: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

// ---- Helpers ----

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}


/// Validate nickname: 4-24 chars, alphanumeric/spaces/dots/underscores/hyphens,
/// must start and end with alphanumeric, no consecutive _ or -, no consecutive spaces.
fn validate_nickname(name: &str) -> Result<(), &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Nickname cannot be empty");
    }
    if trimmed.len() < 4 {
        return Err("Nickname must be at least 4 characters");
    }
    if trimmed.len() > 24 {
        return Err("Nickname must be 24 characters or fewer");
    }
    let first = trimmed.chars().next().unwrap();
    let last = trimmed.chars().last().unwrap();
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return Err("Nickname must start and end with a letter or number");
    }
    let mut prev = '\0';
    for ch in trimmed.chars() {
        if !ch.is_ascii_alphanumeric() && ch != ' ' && ch != '.' && ch != '_' && ch != '-' {
            return Err("Only letters, numbers, spaces, dots, _ and - allowed");
        }
        if (ch == '_' || ch == '-') && (prev == '_' || prev == '-') {
            return Err("No consecutive _ or -");
        }
        if ch == ' ' && prev == ' ' {
            return Err("No consecutive spaces");
        }
        prev = ch;
    }
    Ok(())
}

fn emit_error(socket: &SocketRef, msg: &str) {
    socket
        .emit("error", &ErrorPayload {
            message: msg.to_string(),
        })
        .ok();
}

// ---- Socket.IO Handlers ----

pub fn on_connect(socket: SocketRef, Data(auth): Data<AuthData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    info!("Socket connected: {sid}, nickname: {}", auth.nickname);

    // Validate nickname before proceeding
    if let Err(reason) = validate_nickname(&auth.nickname) {
        warn!("Rejected socket {sid}: {reason}");
        emit_error(&socket, reason);
        socket.disconnect().ok();
        return;
    }

    // Generate auth challenge nonce
    let nonce: [u8; 32] = rand::thread_rng().gen();
    let nonce_hex = hex::encode(nonce);

    // Store pending session (not yet authenticated)
    let session = UserSession {
        user_id: String::new(),
        nickname: auth.nickname.clone(),
        public_key: auth.public_key.clone(),
        authenticated: false,
        auth_nonce: Some(nonce.to_vec()),
        rooms: HashSet::new(),
    };
    hub.sessions.insert(sid.clone(), session);

    // Send challenge
    socket
        .emit(
            "auth_challenge",
            &serde_json::json!({ "nonce": nonce_hex }),
        )
        .ok();

    // Register event handlers
    socket.on("auth_response", on_auth_response);
    socket.on("join_room", on_join_room);
    socket.on("leave_room", on_leave_room);
    socket.on("message", on_message);
    socket.on("dm", on_dm);
    socket.on("set_nickname", on_set_nickname);
    socket.on("file_list_request", on_file_list_request);
    socket.on("file_list_response", on_file_list_response);
    socket.on("file_search", on_file_search);
    socket.on("file_search_response", on_file_search_response);
    socket.on("p2p_multiaddr", on_p2p_multiaddr);
    socket.on("avatar_updated", on_avatar_updated);

    // Handle disconnect
    let hub_clone = hub.0.clone();
    socket.on_disconnect(move |socket: SocketRef| {
        let sid = socket.id.to_string();
        if let Some(session) = hub_clone.remove_user(&sid) {
            if session.authenticated {
                info!(
                    "User disconnected: {} ({})",
                    session.nickname, session.user_id
                );

                // Broadcast peer_left to each room the user was in
                for room in &session.rooms {
                    socket
                        .to(room.clone())
                        .emit(
                            "peer_left",
                            &PeerEventPayload {
                                user_id: session.user_id.clone(),
                                nickname: session.nickname.clone(),
                                room: room.clone(),
                                has_avatar: false,
                            },
                        )
                        .ok();
                }

                // Broadcast updated peer count
                let count = hub_clone.peer_count();
                socket
                    .broadcast()
                    .emit("status", &serde_json::json!({ "peerCount": count }))
                    .ok();
            }
        }
    });
}

fn on_auth_response(socket: SocketRef, Data(data): Data<AuthResponse>, hub: State<HubState>) {
    let sid = socket.id.to_string();

    let session = match hub.get_session(&sid) {
        Some(s) => s,
        None => {
            emit_error(&socket, "Session not found");
            socket.disconnect().ok();
            return;
        }
    };

    if session.authenticated {
        return; // Already authenticated
    }

    let nonce = match &session.auth_nonce {
        Some(n) => n.clone(),
        None => {
            emit_error(&socket, "No auth challenge pending");
            socket.disconnect().ok();
            return;
        }
    };

    // Verify the signature
    if !auth::verify_signature(&session.public_key, &nonce, &data.signature) {
        warn!("Auth failed for socket {sid}: invalid signature");
        emit_error(&socket, "Authentication failed: invalid signature");
        socket.disconnect().ok();
        return;
    }

    // Derive user_id from public key
    let user_id = match auth::derive_user_id(&session.public_key) {
        Some(id) => id,
        None => {
            emit_error(&socket, "Invalid public key");
            socket.disconnect().ok();
            return;
        }
    };

    // Atomically claim nickname (prevents race condition)
    let nickname = session.nickname.clone();
    if let Err(_) = hub.claim_nickname(&nickname, &user_id) {
        emit_error(
            &socket,
            &format!("Nickname '{}' is already taken", nickname),
        );
        socket.disconnect().ok();
        return;
    }

    // Register authenticated user
    let authenticated_session = UserSession {
        user_id: user_id.clone(),
        nickname: nickname.clone(),
        public_key: session.public_key.clone(),
        authenticated: true,
        auth_nonce: None,
        rooms: HashSet::new(),
    };

    hub.register_user(&sid, authenticated_session);
    hub.db
        .upsert_user(&user_id, &session.public_key, &nickname);

    info!("User authenticated: {} ({}) [{}]", nickname, user_id, sid);

    // Join a private room for this user_id (used for DM routing)
    socket.join(format!("user:{}", user_id)).ok();

    // Send auth success
    socket
        .emit("auth_success", &serde_json::json!({ "userId": user_id }))
        .ok();

    // Send status
    let count = hub.peer_count();
    socket
        .emit(
            "status",
            &StatusPayload {
                user_id,
                nickname,
                peer_count: count,
            },
        )
        .ok();

    // Broadcast updated peer count to everyone else
    socket
        .broadcast()
        .emit("status", &serde_json::json!({ "peerCount": count }))
        .ok();
}

fn on_join_room(socket: SocketRef, Data(data): Data<JoinRoomData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let room = data.room.trim().to_string();
    if room.is_empty() {
        emit_error(&socket, "Room name cannot be empty");
        return;
    }

    info!(
        "{} ({}) joining room: {}",
        session.nickname, session.user_id, room
    );

    // Join the Socket.IO room
    socket.join(room.clone()).ok();

    // Track in our state (returns true if newly joined)
    let is_new = hub.join_room(&sid, &room);

    // Send room history
    let history = hub.db.get_room_history(&room);
    // Cache avatar lookups to avoid redundant stat() calls
    let mut avatar_cache = std::collections::HashMap::new();
    socket
        .emit(
            "room_history",
            &HistoryPayload {
                room: room.clone(),
                messages: history
                    .into_iter()
                    .map(|m| {
                        let has_avatar = *avatar_cache
                            .entry(m.sender_id.clone())
                            .or_insert_with(|| hub.has_avatar(&m.sender_id));
                        HistoryMessage {
                            sender: m.sender_id,
                            nickname: m.nickname,
                            text: m.text,
                            timestamp: m.timestamp,
                            has_avatar,
                        }
                    })
                    .collect(),
            },
        )
        .ok();

    // Send member list
    let members = hub.get_room_members(&room);
    socket
        .emit(
            "member_list",
            &MemberListPayload {
                room: room.clone(),
                members: members
                    .into_iter()
                    .map(|(user_id, nickname)| {
                        let has_avatar = hub.has_avatar(&user_id);
                        MemberInfo { user_id, nickname, has_avatar }
                    })
                    .collect(),
            },
        )
        .ok();

    // Broadcast peer_joined to others only if this is a new join (not a re-join after refresh)
    if is_new {
        socket
            .to(room.clone())
            .emit(
                "peer_joined",
                &PeerEventPayload {
                    user_id: session.user_id.clone(),
                    nickname: session.nickname,
                    room,
                    has_avatar: hub.has_avatar(&session.user_id),
                },
            )
            .ok();
    }
}

fn on_leave_room(socket: SocketRef, Data(data): Data<LeaveRoomData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => return,
    };

    let room = data.room;
    info!("{} leaving room: {}", session.nickname, room);

    // Broadcast peer_left before leaving (to = excludes self)
    socket
        .to(room.clone())
        .emit(
            "peer_left",
            &PeerEventPayload {
                user_id: session.user_id.clone(),
                nickname: session.nickname,
                room: room.clone(),
                has_avatar: false,
            },
        )
        .ok();

    // Leave Socket.IO room and track in state
    socket.leave(room.clone()).ok();
    hub.leave_room(&sid, &room);
}

fn on_message(socket: SocketRef, Data(data): Data<MessageData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let room = data.room;
    let text = data.text;
    let timestamp = now_ms();

    // Store in database
    hub.db
        .store_message(&room, &session.user_id, &session.nickname, &text, timestamp);

    let payload = MessagePayload {
        room: room.clone(),
        sender: session.user_id,
        nickname: session.nickname,
        text,
        timestamp,
    };

    // Broadcast to all in room including sender (within = includes self)
    socket.within(room).emit("message", &payload).ok();
}

fn on_dm(socket: SocketRef, Data(data): Data<DmData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let target_id = data.target_id;
    let text = data.text;
    let timestamp = now_ms();

    let payload = DmPayload {
        sender: session.user_id.clone(),
        nickname: session.nickname.clone(),
        text,
        timestamp,
    };

    // Route DM via user-ID room (more reliable than SID rooms)
    let target_room = format!("user:{}", target_id);
    if hub.socket_id_for_user(&target_id).is_some() {
        info!(
            "DM from {} ({}) to {} → room {}",
            session.nickname, session.user_id, target_id, target_room
        );
        // Emit to target's user-ID room
        socket.to(target_room).emit("dm", &payload).ok();
        // Echo back to sender so they see their own DM
        socket.emit("dm", &payload).ok();
    } else {
        warn!("DM target {} is not online", target_id);
        emit_error(&socket, &format!("User {} is not online", target_id));
    }
}

fn on_set_nickname(socket: SocketRef, Data(data): Data<SetNicknameData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => return,
    };

    let new_nickname = data.nickname.trim().to_string();
    if let Err(reason) = validate_nickname(&new_nickname) {
        emit_error(&socket, reason);
        return;
    }

    let old_nickname = session.nickname.clone();

    // Atomically claim new nickname (skip if just changing case)
    if new_nickname.to_lowercase() != old_nickname.to_lowercase() {
        if let Err(_) = hub.claim_nickname(&new_nickname, &session.user_id) {
            emit_error(
                &socket,
                &format!("Nickname '{}' is already taken", new_nickname),
            );
            return;
        }
        // Release old nickname
        hub.active_nicknames.remove(&old_nickname.to_lowercase());
    }

    if let Some(mut s) = hub.sessions.get_mut(&sid) {
        s.nickname = new_nickname.clone();
    }

    hub.db
        .update_nickname(&session.user_id, &old_nickname, &new_nickname);

    info!("{} changed nickname to {}", old_nickname, new_nickname);

    // Broadcast to all connected users
    socket
        .broadcast()
        .emit(
            "nickname_changed",
            &NicknameChangedPayload {
                user_id: session.user_id,
                old_nickname,
                new_nickname,
            },
        )
        .ok();
}

fn on_file_list_request(
    socket: SocketRef,
    Data(data): Data<FileListRequestData>,
    hub: State<HubState>,
) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let target_room = format!("user:{}", data.target_id);
    if hub.socket_id_for_user(&data.target_id).is_some() {
        info!(
            "File list request from {} ({}) to {}",
            session.nickname, session.user_id, data.target_id
        );
        socket
            .to(target_room)
            .emit(
                "file_list_request",
                &serde_json::json!({
                    "requesterId": session.user_id,
                    "requesterNickname": session.nickname,
                }),
            )
            .ok();
    } else {
        emit_error(
            &socket,
            &format!("User {} is not online", data.target_id),
        );
    }
}

#[derive(Debug, Deserialize)]
struct P2PMultiaddrData {
    multiaddr: String,
}

fn on_p2p_multiaddr(socket: SocketRef, Data(data): Data<P2PMultiaddrData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => return,
    };

    info!(
        "P2P multiaddr from {} ({}): {}",
        session.nickname, session.user_id, data.multiaddr
    );

    // Broadcast to all other authenticated users
    socket
        .broadcast()
        .emit(
            "p2p_multiaddr",
            &serde_json::json!({
                "userId": session.user_id,
                "multiaddr": data.multiaddr,
            }),
        )
        .ok();
}

fn on_file_list_response(
    socket: SocketRef,
    Data(data): Data<FileListResponseData>,
    hub: State<HubState>,
) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let target_room = format!("user:{}", data.requester_id);
    if hub.socket_id_for_user(&data.requester_id).is_some() {
        info!(
            "File list response from {} ({}) to {}",
            session.nickname, session.user_id, data.requester_id
        );
        socket
            .to(target_room)
            .emit("file_list_response", &data.data)
            .ok();
    } else {
        warn!(
            "File list response target {} is not online",
            data.requester_id
        );
    }
}

#[derive(Debug, Deserialize)]
struct FileSearchData {
    #[serde(rename = "searchId")]
    search_id: String,
    query: String,
}

#[derive(Debug, Deserialize)]
struct FileSearchResponsePayload {
    #[serde(rename = "searchId")]
    search_id: String,
    #[serde(rename = "requesterId")]
    requester_id: String,
    results: serde_json::Value,
}

fn on_file_search(socket: SocketRef, Data(data): Data<FileSearchData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    info!(
        "File search from {} ({}): query=\"{}\"",
        session.nickname, session.user_id, data.query
    );

    socket
        .broadcast()
        .emit(
            "file_search_request",
            &serde_json::json!({
                "searchId": data.search_id,
                "query": data.query,
                "requesterId": session.user_id,
            }),
        )
        .ok();
}

fn on_file_search_response(
    socket: SocketRef,
    Data(data): Data<FileSearchResponsePayload>,
    hub: State<HubState>,
) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => {
            emit_error(&socket, "Not authenticated");
            return;
        }
    };

    let target_room = format!("user:{}", data.requester_id);
    if hub.socket_id_for_user(&data.requester_id).is_some() {
        info!(
            "File search response from {} ({}) to {}",
            session.nickname, session.user_id, data.requester_id
        );
        socket
            .to(target_room)
            .emit(
                "file_search_response",
                &serde_json::json!({
                    "searchId": data.search_id,
                    "results": data.results,
                }),
            )
            .ok();
    }
}

#[derive(Debug, Deserialize)]
struct AvatarUpdatedData {
    #[serde(rename = "hasAvatar")]
    has_avatar: bool,
}

fn on_avatar_updated(socket: SocketRef, Data(data): Data<AvatarUpdatedData>, hub: State<HubState>) {
    let sid = socket.id.to_string();
    let session = match hub.get_session(&sid) {
        Some(s) if s.authenticated => s,
        _ => return,
    };

    info!(
        "Avatar updated for {} ({}): hasAvatar={}",
        session.nickname, session.user_id, data.has_avatar
    );

    // Broadcast to all other connected clients
    socket
        .broadcast()
        .emit(
            "avatar_updated",
            &serde_json::json!({
                "userId": session.user_id,
                "hasAvatar": data.has_avatar,
            }),
        )
        .ok();
}
