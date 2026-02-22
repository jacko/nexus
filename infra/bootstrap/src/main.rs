use clap::Parser;
use futures::StreamExt;
use libp2p::{
    autonat, gossipsub, identify, identity::Keypair, kad, noise, relay, tcp, yamux, Multiaddr,
    StreamProtocol, SwarmBuilder,
};
use std::path::Path;
use std::time::Duration;
use tracing::info;

#[derive(Parser)]
#[command(name = "nexus-bootstrap", about = "Nexus P2P bootstrap node")]
struct Args {
    /// Port to listen on (TCP and QUIC/UDP)
    #[arg(short, long, default_value_t = 4001)]
    port: u16,

    /// Directory for persistent data (identity key file)
    #[arg(long, default_value = "./data")]
    data_dir: String,
}

fn load_or_generate_keypair(path: &Path) -> Keypair {
    if path.exists() {
        let bytes = std::fs::read(path).expect("failed to read identity file");
        Keypair::ed25519_from_bytes(bytes).expect("invalid ed25519 key")
    } else {
        let keypair = Keypair::generate_ed25519();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Ok(ed25519_kp) = keypair.clone().try_into_ed25519() {
            std::fs::write(path, ed25519_kp.secret().as_ref()).ok();
        }
        keypair
    }
}

#[derive(libp2p::swarm::NetworkBehaviour)]
struct BootstrapBehaviour {
    kademlia: kad::Behaviour<kad::store::MemoryStore>,
    identify: identify::Behaviour,
    gossipsub: gossipsub::Behaviour,
    autonat: autonat::Behaviour,
    relay: relay::Behaviour,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("nexus_bootstrap=info".parse().unwrap())
                .add_directive("libp2p_gossipsub=info".parse().unwrap()),
        )
        .init();

    let args = Args::parse();

    let key_path = Path::new(&args.data_dir).join("identity.key");
    let keypair = load_or_generate_keypair(&key_path);

    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .expect("transport")
        .with_quic()
        .with_behaviour(|key| {
            // Kademlia in server mode for peer discovery
            let kad_config = kad::Config::new(StreamProtocol::new("/nexus/kad/1.0.0"));
            let store = kad::store::MemoryStore::new(key.public().to_peer_id());
            let mut kademlia =
                kad::Behaviour::with_config(key.public().to_peer_id(), store, kad_config);
            kademlia.set_mode(Some(kad::Mode::Server));

            // Identify so peers learn each other's addresses
            let identify = identify::Behaviour::new(
                identify::Config::new(
                    "/nexus/id/1.0.0".into(),
                    key.public(),
                )
                .with_push_listen_addr_updates(true),
            );

            // Gossipsub so the bootstrap can relay chat messages
            let gossipsub_config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(1))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .max_transmit_size(65536)
                .mesh_n(3)
                .mesh_n_low(2)
                .mesh_n_high(6)
                .mesh_outbound_min(1)
                .build()
                .expect("valid gossipsub config");

            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub_config,
            )
            .expect("valid gossipsub behaviour");

            // AutoNAT server — responds to NAT probes from clients
            let autonat = autonat::Behaviour::new(
                key.public().to_peer_id(),
                autonat::Config {
                    only_global_ips: true,
                    ..Default::default()
                },
            );

            // Circuit Relay v2 server — NATted peers reserve slots through us
            let relay = relay::Behaviour::new(
                key.public().to_peer_id(),
                relay::Config {
                    max_reservations: 128,
                    max_reservations_per_peer: 4,
                    max_circuits: 64,
                    max_circuits_per_peer: 4,
                    max_circuit_duration: Duration::from_secs(120),
                    max_circuit_bytes: 1 << 20, // 1MB — enough for chat/DMs/DCUtR coordination
                    ..Default::default()
                },
            );

            Ok(BootstrapBehaviour {
                kademlia,
                identify,
                gossipsub,
                autonat,
                relay,
            })
        })
        .expect("behaviour")
        .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();

    let tcp_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", args.port)
        .parse()
        .expect("valid TCP multiaddr");
    swarm.listen_on(tcp_addr).expect("can listen on TCP");

    let quic_addr: Multiaddr = format!("/ip4/0.0.0.0/udp/{}/quic-v1", args.port)
        .parse()
        .expect("valid QUIC multiaddr");
    swarm.listen_on(quic_addr).expect("can listen on QUIC");

    let peer_id = *swarm.local_peer_id();
    info!("Bootstrap node started with PeerId: {peer_id}");
    info!("Identity persisted at: {}", key_path.display());
    info!("Listening on TCP and QUIC port {}", args.port);
    info!(
        "TCP:  /ip4/127.0.0.1/tcp/{}/p2p/{peer_id}",
        args.port
    );
    info!(
        "QUIC: /ip4/127.0.0.1/udp/{}/quic-v1/p2p/{peer_id}",
        args.port
    );

    loop {
        match swarm.select_next_some().await {
            libp2p::swarm::SwarmEvent::NewListenAddr { address, .. } => {
                info!("Listening on: {address}/p2p/{peer_id}");
            }
            libp2p::swarm::SwarmEvent::ConnectionEstablished {
                peer_id: remote, ..
            } => {
                info!("Peer connected: {remote}");
            }
            libp2p::swarm::SwarmEvent::ConnectionClosed {
                peer_id: remote, ..
            } => {
                info!("Peer disconnected: {remote}");
            }
            libp2p::swarm::SwarmEvent::Behaviour(BootstrapBehaviourEvent::Identify(
                identify::Event::Received {
                    peer_id: id_peer,
                    info,
                    ..
                },
            )) => {
                for addr in info.listen_addrs {
                    swarm
                        .behaviour_mut()
                        .kademlia
                        .add_address(&id_peer, addr);
                }
                info!("Identified peer: {id_peer}");
            }
            // Auto-subscribe to topics when peers subscribe, so bootstrap relays messages
            libp2p::swarm::SwarmEvent::Behaviour(BootstrapBehaviourEvent::Gossipsub(
                gossipsub::Event::Subscribed { peer_id: sub_peer, topic },
            )) => {
                info!("Peer {sub_peer} subscribed to {topic}");
                // Subscribe ourselves so we can relay messages between peers
                let ident_topic = gossipsub::IdentTopic::new(topic.to_string());
                if let Err(e) = swarm.behaviour_mut().gossipsub.subscribe(&ident_topic) {
                    info!("Already subscribed or error: {e}");
                } else {
                    info!("Auto-subscribed to {topic} for relay");
                }
            }
            libp2p::swarm::SwarmEvent::Behaviour(BootstrapBehaviourEvent::Kademlia(
                kad::Event::RoutingUpdated {
                    peer, addresses, ..
                },
            )) => {
                info!(
                    "Kademlia routing updated: {peer} ({} addrs)",
                    addresses.len()
                );
            }
            libp2p::swarm::SwarmEvent::Behaviour(BootstrapBehaviourEvent::Autonat(event)) => {
                info!("AutoNAT: {:?}", event);
            }
            libp2p::swarm::SwarmEvent::Behaviour(BootstrapBehaviourEvent::Relay(event)) => {
                info!("Relay: {:?}", event);
            }
            _ => {}
        }
    }
}
