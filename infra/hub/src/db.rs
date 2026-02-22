use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct StoredMessage {
    pub sender_id: String,
    pub nickname: String,
    pub text: String,
    pub timestamp: u64,
}

pub struct Database {
    conn: Mutex<Connection>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

impl Database {
    pub fn new(path: &str) -> Self {
        let conn = Connection::open(path).expect("failed to open database");

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS users (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL UNIQUE,
                public_key TEXT NOT NULL UNIQUE,
                nickname   TEXT NOT NULL,
                last_seen  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id        TEXT PRIMARY KEY,
                room      TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                nickname  TEXT NOT NULL,
                text      TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_room_ts
                ON messages(room, timestamp DESC);

            CREATE TABLE IF NOT EXISTS nickname_history (
                id           TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL,
                old_nickname TEXT NOT NULL,
                new_nickname TEXT NOT NULL,
                changed_at   INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_nickname_history_user
                ON nickname_history(user_id, changed_at DESC);
            ",
        )
        .expect("failed to initialize schema");

        // Enable WAL mode for better concurrent read/write
        conn.pragma_update(None, "journal_mode", "WAL").ok();

        Self {
            conn: Mutex::new(conn),
        }
    }

    pub fn store_message(
        &self,
        room: &str,
        sender_id: &str,
        nickname: &str,
        text: &str,
        timestamp: u64,
    ) {
        let conn = self.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO messages (id, room, sender_id, nickname, text, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, room, sender_id, nickname, text, timestamp],
        )
        .ok();

        // Prune old messages beyond 50 per room
        conn.execute(
            "DELETE FROM messages WHERE room = ?1 AND id NOT IN (
                SELECT id FROM messages WHERE room = ?1 ORDER BY timestamp DESC LIMIT 50
            )",
            params![room],
        )
        .ok();
    }

    pub fn get_room_history(&self, room: &str) -> Vec<StoredMessage> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT sender_id, nickname, text, timestamp FROM messages
                 WHERE room = ?1 ORDER BY timestamp ASC LIMIT 50",
            )
            .expect("valid query");

        stmt.query_map(params![room], |row| {
            Ok(StoredMessage {
                sender_id: row.get(0)?,
                nickname: row.get(1)?,
                text: row.get(2)?,
                timestamp: row.get(3)?,
            })
        })
        .expect("valid result")
        .filter_map(|r| r.ok())
        .collect()
    }

    /// Check if a nickname is already taken by a different user in the DB.
    /// Returns Ok(()) if available or owned by the same user, Err(owner_user_id) if taken.
    pub fn check_nickname_owner(&self, nickname: &str, user_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let result: Option<String> = conn
            .query_row(
                "SELECT user_id FROM users WHERE LOWER(nickname) = LOWER(?1)",
                params![nickname],
                |row| row.get(0),
            )
            .ok();

        match result {
            None => Ok(()),                          // No one has it
            Some(ref owner) if owner == user_id => Ok(()), // Same user
            Some(owner) => Err(owner),               // Taken by someone else
        }
    }

    pub fn upsert_user(&self, user_id: &str, public_key: &str, nickname: &str) {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();

        // Check if user exists and nickname changed
        let old_nickname: Option<String> = conn
            .query_row(
                "SELECT nickname FROM users WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .ok();

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, user_id, public_key, nickname, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id) DO UPDATE SET nickname = ?4, last_seen = ?5",
            params![id, user_id, public_key, nickname, now],
        )
        .ok();

        // Record nickname change if it differs from the previous one
        if let Some(old) = old_nickname {
            if old != nickname {
                let hist_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO nickname_history (id, user_id, old_nickname, new_nickname, changed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![hist_id, user_id, old, nickname, now],
                )
                .ok();
            }
        }
    }

    pub fn update_nickname(&self, user_id: &str, old_nickname: &str, new_nickname: &str) {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();

        // Update current nickname
        conn.execute(
            "UPDATE users SET nickname = ?1 WHERE user_id = ?2",
            params![new_nickname, user_id],
        )
        .ok();

        // Record in nickname history
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO nickname_history (id, user_id, old_nickname, new_nickname, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, user_id, old_nickname, new_nickname, now],
        )
        .ok();
    }

    #[allow(dead_code)]
    pub fn get_nickname_history(&self, user_id: &str) -> Vec<NicknameRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT old_nickname, new_nickname, changed_at FROM nickname_history
                 WHERE user_id = ?1 ORDER BY changed_at DESC LIMIT 50",
            )
            .expect("valid query");

        stmt.query_map(params![user_id], |row| {
            Ok(NicknameRecord {
                old_nickname: row.get(0)?,
                new_nickname: row.get(1)?,
                changed_at: row.get(2)?,
            })
        })
        .expect("valid result")
        .filter_map(|r| r.ok())
        .collect()
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct NicknameRecord {
    pub old_nickname: String,
    pub new_nickname: String,
    pub changed_at: u64,
}
