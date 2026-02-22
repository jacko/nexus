use crate::db::Database;
use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;

/// Per-connected-user session info
#[derive(Debug, Clone)]
pub struct UserSession {
    pub user_id: String,
    pub nickname: String,
    pub public_key: String,
    pub authenticated: bool,
    pub auth_nonce: Option<Vec<u8>>,
    pub rooms: HashSet<String>,
}

/// Shared hub state across all socket handlers
#[derive(Clone)]
pub struct HubState {
    /// Socket ID → UserSession (populated after auth)
    pub sessions: Arc<DashMap<String, UserSession>>,
    /// user_id → socket_id (for DM routing)
    pub user_to_socket: Arc<DashMap<String, String>>,
    /// Active nicknames (for uniqueness enforcement)
    pub active_nicknames: Arc<DashMap<String, String>>,
    /// Room → set of socket_ids (for member listing)
    pub room_members: Arc<DashMap<String, HashSet<String>>>,
    /// Database
    pub db: Arc<Database>,
    /// Data directory for avatars etc.
    pub data_dir: String,
}

impl HubState {
    pub fn new(db_path: &str, data_dir: &str) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            user_to_socket: Arc::new(DashMap::new()),
            active_nicknames: Arc::new(DashMap::new()),
            room_members: Arc::new(DashMap::new()),
            db: Arc::new(Database::new(db_path)),
            data_dir: data_dir.to_string(),
        }
    }

    pub fn peer_count(&self) -> usize {
        self.sessions.iter().filter(|s| s.authenticated).count()
    }

    /// Atomically claim a nickname for a user. Returns Ok(()) on success,
    /// Err(owner_user_id) if taken by a different user.
    /// Checks both in-memory (online users) and DB (all known users).
    pub fn claim_nickname(&self, nickname: &str, user_id: &str) -> Result<(), String> {
        // Check DB first — is this nickname permanently owned by someone else?
        self.db.check_nickname_owner(nickname, user_id)?;

        // Then claim in-memory for online uniqueness
        let key = nickname.to_lowercase();
        match self.active_nicknames.entry(key) {
            dashmap::mapref::entry::Entry::Vacant(e) => {
                e.insert(user_id.to_string());
                Ok(())
            }
            dashmap::mapref::entry::Entry::Occupied(e) => {
                if e.get() == user_id {
                    Ok(()) // Same user reconnecting — allow
                } else {
                    Err(e.get().clone())
                }
            }
        }
    }

    pub fn register_user(&self, socket_id: &str, session: UserSession) {
        let user_id = session.user_id.clone();
        // Kick any previous socket for the same user_id (handles reconnect)
        if let Some((_, old_sid)) = self.user_to_socket.remove(&user_id) {
            self.sessions.remove(&old_sid);
        }
        self.user_to_socket.insert(user_id, socket_id.to_string());
        self.sessions.insert(socket_id.to_string(), session);
    }

    pub fn remove_user(&self, socket_id: &str) -> Option<UserSession> {
        if let Some((_, session)) = self.sessions.remove(socket_id) {
            self.user_to_socket.remove(&session.user_id);
            self.active_nicknames.remove(&session.nickname.to_lowercase());
            // Remove from all rooms
            for room in &session.rooms {
                if let Some(mut members) = self.room_members.get_mut(room) {
                    members.remove(socket_id);
                    if members.is_empty() {
                        drop(members);
                        self.room_members.remove(room);
                    }
                }
            }
            Some(session)
        } else {
            None
        }
    }

    /// Returns true if this is a new join, false if already in the room.
    pub fn join_room(&self, socket_id: &str, room: &str) -> bool {
        self.room_members
            .entry(room.to_string())
            .or_default()
            .insert(socket_id.to_string());
        if let Some(mut session) = self.sessions.get_mut(socket_id) {
            session.rooms.insert(room.to_string())
        } else {
            false
        }
    }

    pub fn leave_room(&self, socket_id: &str, room: &str) {
        if let Some(mut members) = self.room_members.get_mut(room) {
            members.remove(socket_id);
            if members.is_empty() {
                drop(members);
                self.room_members.remove(room);
            }
        }
        if let Some(mut session) = self.sessions.get_mut(socket_id) {
            session.rooms.remove(room);
        }
    }

    pub fn get_room_members(&self, room: &str) -> Vec<(String, String)> {
        let socket_ids: Vec<String> = self
            .room_members
            .get(room)
            .map(|m| m.iter().cloned().collect())
            .unwrap_or_default();

        socket_ids
            .iter()
            .filter_map(|sid| {
                self.sessions.get(sid).and_then(|s| {
                    if s.authenticated {
                        Some((s.user_id.clone(), s.nickname.clone()))
                    } else {
                        None
                    }
                })
            })
            .collect()
    }

    #[allow(dead_code)]
    pub fn user_rooms(&self, socket_id: &str) -> Vec<String> {
        self.sessions
            .get(socket_id)
            .map(|s| s.rooms.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_session(&self, socket_id: &str) -> Option<UserSession> {
        self.sessions.get(socket_id).map(|s| s.clone())
    }

    pub fn socket_id_for_user(&self, user_id: &str) -> Option<String> {
        self.user_to_socket.get(user_id).map(|s| s.clone())
    }

    pub fn has_avatar(&self, user_id: &str) -> bool {
        std::path::Path::new(&self.data_dir)
            .join("avatars")
            .join(format!("{user_id}_128.webp"))
            .exists()
    }
}
