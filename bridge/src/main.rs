// gh-actions-bridge [port]   (既定 8799)。systemd --user で常駐させる (gh-actions-bridge.service)
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(8799);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[bridge] 0.0.0.0:{port} を bind できない: {e} (もう 1 本動いている? systemctl --user status gh-actions-bridge)");
            std::process::exit(1);
        }
    };
    eprintln!("[bridge] listening on 0.0.0.0:{port}");
    let app = gh_actions_bridge::app(port).into_make_service_with_connect_info::<SocketAddr>();
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[bridge] serve: {e}");
        std::process::exit(1);
    }
}
