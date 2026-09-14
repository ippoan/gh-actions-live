// 実物のサーバーを空きポートで起こし、偽の拡張と /watch の socket で通しで確かめる。
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{Error, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = gh_actions_bridge::app(port).into_make_service_with_connect_info::<std::net::SocketAddr>();
        axum::serve(l, app).await.unwrap();
    });
    port
}

async fn start_with_refresh(every: Duration) -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = gh_actions_bridge::app_with_refresh(port, every).into_make_service_with_connect_info::<std::net::SocketAddr>();
        axum::serve(l, app).await.unwrap();
    });
    port
}

async fn connect(port: u16, path: &str) -> Ws {
    connect_async(format!("ws://127.0.0.1:{port}{path}")).await.unwrap().0
}

/// 次のテキストフレーム。bridge が閉じたら None。keepalive の ping は飛ばす
async fn next_text(ws: &mut Ws) -> Option<String> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.expect("3 秒待っても来ない")?.ok()?;
        match m {
            Message::Text(t) if !t.as_str().contains(r#""type":"ping""#) => return Some(t.to_string()),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// next_text と同じく ping を読み飛ばすが、`dur` 全体で 1 つのタイムアウトを掛ける
/// (来ないことを確かめたいテスト用。keepalive の即時 ping はここでも読み飛ばす)
async fn next_text_within(ws: &mut Ws, dur: Duration) -> Result<Option<String>, tokio::time::error::Elapsed> {
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let m = tokio::time::timeout(remaining, ws.next()).await?;
        match m {
            Some(Ok(Message::Text(t))) if !t.as_str().contains(r#""type":"ping""#) => return Ok(Some(t.to_string())),
            Some(Ok(Message::Text(_))) => continue,
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Err(_)) => return Ok(None),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn watch_gets_only_matching_run_and_is_closed_when_it_finishes() {
    let port = start().await;
    let mut ext = connect(port, "/?role=extension").await;
    send(&mut ext, json!({ "type": "snapshot", "runs": [
        { "repo": "ippoan/x", "workflow": "CI", "run": "10", "status": "currently running", "ref": "feat-a", "title": "t" },
        { "repo": "ippoan/y", "workflow": "CI", "run": "5", "status": "currently running", "ref": "feat-b", "title": "u" },
    ] }))
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut w = connect(port, "/watch?repo=ippoan/x&workflow=ci&run=10").await;
    assert_eq!(next_text(&mut w).await.as_deref(), Some("ippoan/x CI #10: currently running [feat-a] — t"));

    send(&mut ext, json!({ "type": "events", "events": [
        { "repo": "ippoan/y", "workflow": "CI", "run": "5", "from": "currently running", "label": "failed", "ref": "feat-b" },
        { "repo": "ippoan/x", "workflow": "CI", "run": "10", "from": "currently running", "label": "completed successfully", "ref": "feat-a", "title": "t" },
    ] }))
    .await;
    assert_eq!(
        next_text(&mut w).await.as_deref(),
        Some("ippoan/x CI #10: currently running → completed successfully [feat-a] — t")
    );
    assert_eq!(next_text(&mut w).await, None, "run が終わったら bridge が閉じる");
}

#[tokio::test]
async fn watch_without_condition_is_rejected() {
    let port = start().await;
    match connect_async(format!("ws://127.0.0.1:{port}/watch")).await {
        Err(Error::Http(res)) => assert_eq!(res.status(), 400),
        other => panic!("400 のはず: {:?}", other.map(|_| ())),
    }
}

#[tokio::test]
async fn watch_says_when_dashboard_is_missing_and_cmd_reaches_extension() {
    let port = start().await;
    let mut w = connect(port, "/watch?repo=ippoan/x").await;
    assert!(next_text(&mut w).await.unwrap().contains("繋がっていない"));

    let mut ext = connect(port, "/?role=extension").await;
    assert!(next_text(&mut w).await.unwrap().contains("繋がった"));

    let body = r#"{"command":"snapshot"}"#;
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!("POST /cmd HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    tcp.write_all(req.as_bytes()).await.unwrap();
    let mut res = String::new();
    tcp.read_to_string(&mut res).await.unwrap();
    assert!(res.contains(r#""delivered_to":1"#), "{res}");

    let got: Value = serde_json::from_str(&next_text(&mut ext).await.unwrap()).unwrap();
    assert_eq!(got, json!({ "type": "command", "command": "snapshot" }));

    drop(ext);
    assert!(next_text(&mut w).await.unwrap().contains("外れた"));
}

#[tokio::test]
async fn auto_refresh_reaches_dashboard() {
    let port = start_with_refresh(Duration::from_millis(200)).await;
    let mut ext = connect(port, "/?role=extension").await;
    let got = tokio::time::timeout(Duration::from_secs(1), next_text(&mut ext)).await.expect("1 秒以内に refresh が来るはず");
    assert_eq!(got, Some(json!({ "type": "command", "command": "refresh" }).to_string()));
}

#[tokio::test]
async fn auto_refresh_does_not_reach_extension_bg() {
    let port = start_with_refresh(Duration::from_millis(200)).await;
    let mut bg = connect(port, "/?role=extension-bg").await;
    let got = next_text_within(&mut bg, Duration::from_millis(700)).await;
    assert!(got.is_err(), "extension-bg には refresh が届かないはず: {got:?}");
}

#[tokio::test]
async fn auto_refresh_skips_the_immediate_tick() {
    let port = start_with_refresh(Duration::from_millis(200)).await;
    let mut ext = connect(port, "/?role=extension").await;
    let got = next_text_within(&mut ext, Duration::from_millis(100)).await;
    assert!(got.is_err(), "起動直後 (100ms 以内) には refresh が来ないはず: {got:?}");
}
