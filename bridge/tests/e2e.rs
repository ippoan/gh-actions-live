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
async fn watch_says_when_github_login_is_lost_and_back() {
    let port = start().await;
    let mut ext = connect(port, "/?role=extension").await;
    let mut w = connect(port, "/watch?repo=ippoan/x").await;

    // 起動直後の初回 login true では行を出さない
    send(&mut ext, json!({ "type": "login", "loggedIn": true, "user": "octocat" })).await;
    assert!(next_text_within(&mut w, Duration::from_millis(300)).await.is_err(), "初回 true では流さない");

    send(&mut ext, json!({ "type": "login", "loggedIn": false, "user": null })).await;
    assert!(next_text(&mut w).await.unwrap().contains("ログインが切れた"));

    // 同じ値の連投では行が増えない
    send(&mut ext, json!({ "type": "login", "loggedIn": false, "user": null })).await;
    assert!(next_text_within(&mut w, Duration::from_millis(300)).await.is_err(), "同じ値では流さない");

    // 切れている間に繋いだ /watch にも切れた行を 1 回送る
    let mut w2 = connect(port, "/watch?repo=ippoan/y").await;
    assert!(next_text(&mut w2).await.unwrap().contains("ログインが切れた"));

    let (_, body) = http(port, "GET", "/", "").await;
    assert!(body.contains(r#""loggedIn":false"#), "{body}");

    send(&mut ext, json!({ "type": "login", "loggedIn": true, "user": "octocat" })).await;
    assert_eq!(next_text(&mut w).await.unwrap(), "watch: GitHub のログインが戻った (octocat)");
    assert!(next_text(&mut w2).await.unwrap().contains("戻った"));
    send(&mut ext, json!({ "type": "login", "loggedIn": true, "user": "octocat" })).await;
    assert!(next_text_within(&mut w, Duration::from_millis(300)).await.is_err(), "同じ値では流さない");
}

#[tokio::test]
async fn first_login_true_is_silent_for_new_watchers() {
    let port = start().await;
    let mut ext = connect(port, "/?role=extension").await;
    send(&mut ext, json!({ "type": "login", "loggedIn": true, "user": "octocat" })).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut w = connect(port, "/watch?repo=ippoan/x").await;
    assert!(next_text_within(&mut w, Duration::from_millis(300)).await.is_err(), "ログイン済みなら繋いだ直後に何も来ない");
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

/// HTTP/1.1 を素で 1 往復する (dev-dependencies に HTTP クライアントを足さないため)。(ステータス行, 本文)
async fn http(port: u16, method: &str, path: &str, body: &str) -> (String, String) {
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tcp.write_all(req.as_bytes()).await.unwrap();
    let mut res = String::new();
    tcp.read_to_string(&mut res).await.unwrap();
    let (head, body) = res.split_once("\r\n\r\n").unwrap_or((&res, ""));
    (head.lines().next().unwrap_or("").to_string(), body.to_string())
}

#[tokio::test]
async fn mcp_tool_returns_runs_the_extension_sent() {
    let port = start().await;
    let mut ext = connect(port, "/?role=extension").await;
    send(&mut ext, json!({ "type": "hello", "role": "extension", "repos": ["ippoan/empty", "ippoan/x"], "version": "0.0.0" })).await;
    send(&mut ext, json!({ "type": "snapshot", "runs": [
        { "repo": "ippoan/x", "workflow": "CI", "run": "10", "status": "currently running", "ref": "feat-a", "title": "t",
          "href": "https://github.com/ippoan/x/actions/runs/1", "at": "2026-11-12T00:00:00Z" },
    ] }))
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (status, body) = http(port, "POST", "/mcp", r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"actions_dashboard_data","arguments":{}}}"#).await;
    assert!(status.contains("200"), "{status}");
    let res: Value = serde_json::from_str(&body).unwrap();
    let d = &res["result"]["structuredContent"];
    assert_eq!(d["connected"], true);
    assert_eq!(d["repos"][0]["repo"], "ippoan/x");
    assert_eq!(d["repos"][0]["runs"][0]["state"], "run");
    assert_eq!(d["repos"][1]["repo"], "ippoan/empty", "hello の repo は run が無くても末尾に出る");

    // モデル向けのツールは要約のテキストだけ (structuredContent を付けるとそちらがモデルに渡るため)
    let (_, body) = http(port, "POST", "/mcp", r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"actions_dashboard","arguments":{}}}"#).await;
    let res: Value = serde_json::from_str(&body).unwrap();
    assert!(res["result"].get("structuredContent").is_none());
    assert!(res["result"]["content"][0]["text"].as_str().unwrap().contains("ippoan/x CI #10: currently running"));

    // 2 つ目のダッシュボードが起動直後の空の snapshot を送っても、写しは消えない (重ねる)
    let mut ext2 = connect(port, "/?role=extension").await;
    send(&mut ext2, json!({ "type": "snapshot", "runs": [] })).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_, body) = http(port, "POST", "/mcp", r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"actions_dashboard_data","arguments":{}}}"#).await;
    let res: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(res["result"]["structuredContent"]["totalRuns"], 1, "空の snapshot で消さない");

    // 通知だけなら 202、壊れた JSON は 400、GET は 405 (SSE は持たない)
    assert!(http(port, "POST", "/mcp", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await.0.contains("202"));
    assert!(http(port, "POST", "/mcp", "{").await.0.contains("400"));
    assert!(http(port, "GET", "/mcp", "").await.0.contains("405"));
}

async fn start_with_token(token: &str) -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let app = gh_actions_bridge::app_with_mcp_token(port, token).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    port
}

/// HTTP/1.1 を素で 1 往復し、ステータス行だけ返す (追加のヘッダ付き)
async fn status_with(port: u16, method: &str, path: &str, extra: &str, body: &str) -> String {
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: x\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    tcp.write_all(req.as_bytes()).await.unwrap();
    let mut res = String::new();
    tcp.read_to_string(&mut res).await.unwrap();
    res.lines().next().unwrap_or("").to_string()
}

#[tokio::test]
async fn public_mcp_needs_the_token_and_tunnel_reaches_nothing_else() {
    let token = "t".repeat(40);
    let port = start_with_token(&token).await;
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let cf = "cf-ray: 1234-NRT\r\n";
    assert!(status_with(port, "POST", &format!("/mcp/{token}"), cf, ping).await.contains("200"));
    assert!(status_with(port, "POST", "/mcp/wrong", cf, ping).await.contains("404"));
    // Tunnel 越しには /mcp/ 以外を出さない
    assert!(status_with(port, "POST", "/cmd", cf, r#"{"command":"snapshot"}"#).await.contains("403"));
    assert!(status_with(port, "POST", "/mcp", cf, ping).await.contains("403"));
    assert!(status_with(port, "GET", "/", cf, "").await.contains("403"));
    // localhost からは今までどおり
    assert!(status_with(port, "POST", "/mcp", "", ping).await.contains("200"));
}

#[tokio::test]
async fn public_mcp_is_closed_without_a_token() {
    let port = start().await;
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    assert!(status_with(port, "POST", &format!("/mcp/{}", "t".repeat(40)), "", ping).await.contains("404"));
}

#[tokio::test]
async fn run_first_seen_in_events_gets_seen_at_until_snapshot_brings_at() {
    let port = start().await;
    let mut ext = connect(port, "/?role=extension").await;
    let data = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"actions_dashboard_data","arguments":{}}}"#;
    // push で初めて現れた run (snapshot の行に無い) には at が無い → 拡張の観測時刻 t を出す
    send(&mut ext, json!({ "type": "events", "events": [
        { "repo": "ippoan/x", "workflow": "CI", "run": "11", "from": "", "label": "currently running", "t": "2026-11-12T05:00:00Z" },
    ] }))
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let res: Value = serde_json::from_str(&http(port, "POST", "/mcp", data).await.1).unwrap();
    assert_eq!(res["result"]["structuredContent"]["repos"][0]["runs"][0]["at"], "2026-11-12T05:00:00Z");

    // 後から来た snapshot の正確な at が勝つ
    send(&mut ext, json!({ "type": "snapshot", "runs": [
        { "repo": "ippoan/x", "workflow": "CI", "run": "11", "status": "currently running", "at": "2026-11-12T04:58:00Z" },
    ] }))
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let res: Value = serde_json::from_str(&http(port, "POST", "/mcp", data).await.1).unwrap();
    assert_eq!(res["result"]["structuredContent"]["repos"][0]["runs"][0]["at"], "2026-11-12T04:58:00Z");
}
