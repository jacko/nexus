use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::identity::Keypair;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Wire format for chat messages on Gossipsub topics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// "message", "join", or "leave"
    pub msg_type: String,
    pub sender: String,
    pub nickname: String,
    pub text: String,
    pub timestamp: u64,
}

impl ChatMessage {
    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    pub fn new_text(sender: &str, nickname: &str, text: &str) -> Self {
        Self {
            msg_type: "message".into(),
            sender: sender.into(),
            nickname: nickname.into(),
            text: text.into(),
            timestamp: Self::now(),
        }
    }

    pub fn new_join(sender: &str, nickname: &str) -> Self {
        Self {
            msg_type: "join".into(),
            sender: sender.into(),
            nickname: nickname.into(),
            text: String::new(),
            timestamp: Self::now(),
        }
    }

    pub fn new_leave(sender: &str, nickname: &str) -> Self {
        Self {
            msg_type: "leave".into(),
            sender: sender.into(),
            nickname: nickname.into(),
            text: String::new(),
            timestamp: Self::now(),
        }
    }
}

/// Topic naming: /nexus/chat/<room_name>
pub fn room_topic(room: &str) -> IdentTopic {
    IdentTopic::new(format!("/nexus/chat/{}", room))
}

/// Extract room name from a topic hash by looking up against known rooms.
/// Since Gossipsub uses TopicHash internally, we track the mapping ourselves.
pub fn room_name_from_topic(topic_str: &str) -> Option<String> {
    topic_str
        .strip_prefix("/nexus/chat/")
        .map(|s| s.to_string())
}

/// Build a Gossipsub behaviour with sensible defaults for chat.
/// Mesh params are tuned for small networks (D=3, D_low=2, D_high=6).
pub fn build_gossipsub(keypair: &Keypair) -> gossipsub::Behaviour {
    let config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(std::time::Duration::from_secs(1))
        .validation_mode(ValidationMode::Strict)
        .max_transmit_size(65536)
        .mesh_n(3)
        .mesh_n_low(2)
        .mesh_n_high(6)
        .mesh_outbound_min(1)
        .build()
        .expect("valid gossipsub config");

    gossipsub::Behaviour::new(MessageAuthenticity::Signed(keypair.clone()), config)
        .expect("valid gossipsub behaviour")
}
