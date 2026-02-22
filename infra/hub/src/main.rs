mod auth;
mod avatar;
mod db;
mod handlers;
mod state;

use axum::routing::{get, post};
use clap::Parser;
use socketioxide::SocketIo;
use state::HubState;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing::info;

#[derive(Parser)]
#[command(name = "nexus-hub", about = "Nexus P2P hub server")]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 4001)]
    port: u16,

    /// SQLite database path
    #[arg(long, default_value = "nexus-hub.db")]
    db_path: String,

    /// Data directory for avatars and other files
    #[arg(long, default_value = "./data")]
    data_dir: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("nexus_hub=info".parse().unwrap()),
        )
        .init();

    let args = Args::parse();

    // Ensure avatars directory exists
    let avatars_path = std::path::Path::new(&args.data_dir).join("avatars");
    std::fs::create_dir_all(&avatars_path).expect("failed to create avatars directory");

    let hub_state = HubState::new(&args.db_path, &args.data_dir);

    let (layer, io) = SocketIo::builder()
        .with_state(hub_state.clone())
        .build_layer();

    io.ns("/", handlers::on_connect);

    let cors = CorsLayer::permissive();

    let app = axum::Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/avatar", post(avatar::upload).delete(avatar::remove))
        .nest_service("/avatars", ServeDir::new(&avatars_path))
        .with_state(hub_state)
        .layer(cors)
        .layer(layer);

    let addr = format!("0.0.0.0:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind");

    let db_full_path = std::fs::canonicalize(&args.db_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&args.db_path));
    let data_full_path = std::fs::canonicalize(&args.data_dir)
        .unwrap_or_else(|_| std::path::PathBuf::from(&args.data_dir));
    info!("Database: {}", db_full_path.display());
    info!("Data dir: {}", data_full_path.display());
    info!("Nexus hub listening on http://{addr}");
    info!("Socket.IO endpoint: http://{addr}/socket.io/");

    axum::serve(listener, app).await.expect("server error");
}
