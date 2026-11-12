//! gh-actions-live の bridge。Windows Chrome 拡張と Claude Code (Linux) をつなぐ常駐リレー。
//!
//! 口はすべて同じポート:
//! - `ws /?role=extension`     拡張のダッシュボード。events / snapshot / hello を送り、コマンドを受ける
//! - `ws /?role=extension-bg`  拡張の service worker。コマンドを受ける
//! - `ws /?role=listener`      拡張の生 JSON を受ける。送った JSON は拡張へのコマンドになる
//! - `ws /watch?repo=…&run=…`  条件に合う run の変化だけを 1 フレーム 1 行のテキストで受ける
//!   (Claude Code の Monitor の ws ソースにそのまま渡す。絞り込みは [`watch`])
//! - `POST /cmd`               本文の JSON を拡張へのコマンドとして送る
//! - `POST /mcp`               MCP (Streamable HTTP の stateless JSON)。全 repo の run をウィジェットで見せる ([`mcp`])
//! - `POST /mcp/<合言葉>`       同じ MCP を Cloudflare Tunnel 越しに claude.ai の custom connector へ出す口。
//!   合言葉は環境変数 `GH_ACTIONS_BRIDGE_MCP_TOKEN` (32 文字以上)。未設定・不一致は 404。
//!   Tunnel 経由 (`cf-ray` ヘッダ付き) の要求はこの口以外すべて 403 (`/cmd` や `/watch` を外に出さない)
//! - `GET /`                   接続中のクライアント一覧
//!
//! セッションから独立して 1 本だけ常駐させる (systemd --user)。セッションが Monitor で bridge 自体を
//! 起動していた頃は 8799 を取り合い、起動したセッションが終わると bridge ごと落ち、
//! 全 repo の変化が起動したセッションにだけ流れていた。
//!
//! stdout には全 repo の変化を 1 行ずつ、接続・切断などは stderr に出す (どちらも journal に入る)。
//!
//! bridge は 5 分ごとにダッシュボードへ `refresh` を送る。alive socket が黙って変化を
//! 取りこぼしたときに Actions ページを取り直させるため。

pub mod mcp;
pub mod watch;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use watch::{Filter, Watch, field, fmt_line, is_active, is_bad, run_key};

struct Client {
    role: String,
    remote: String,
    repos: Vec<String>,
    tx: UnboundedSender<Message>,
}

struct Watcher {
    query: String,
    watch: Watch,
    tx: UnboundedSender<Message>,
}

struct Hub {
    port: u16,
    next_id: u64,
    clients: HashMap<u64, Client>,
    watchers: HashMap<u64, Watcher>,
    /// 直近の snapshot に events を重ねた写し。後から繋いだ listener / watch に渡す
    /// (拡張へ snapshot コマンドを投げ直すと、全 repo の要約行が stdout に出てしまう)
    runs: HashMap<String, Value>,
    /// `/mcp/<合言葉>` の合言葉。None ならその口は閉じている
    mcp_token: Option<String>,
}

type Shared = Arc<Mutex<Hub>>;

// 拡張側の role は 'extension' (ダッシュボード) と 'extension-bg' (service worker) の 2 種。
// コマンドは両方に届ける
fn is_ext(role: &str) -> bool {
    role.starts_with("extension")
}

fn text(s: impl Into<String>) -> Message {
    Message::Text(s.into().into())
}

impl Hub {
    fn has_dashboard(&self) -> bool {
        self.clients.values().any(|c| c.role == "extension")
    }

    fn snapshot(&self) -> Value {
        json!({ "type": "snapshot", "runs": self.runs.values().collect::<Vec<_>>() })
    }

    fn send_role(&self, pick: impl Fn(&str) -> bool, msg: &Value) -> usize {
        let s = msg.to_string();
        self.clients.values().filter(|c| pick(&c.role)).filter(|c| c.tx.send(text(s.clone())).is_ok()).count()
    }

    fn notify_watchers(&self, line: &str) {
        for w in self.watchers.values() {
            let _ = w.tx.send(text(line));
        }
    }

    fn feed_watchers(&mut self, msg: &Value) {
        let mut done = Vec::new();
        for (id, w) in &mut self.watchers {
            for line in w.watch.on_message(msg) {
                let _ = w.tx.send(text(line));
            }
            if w.watch.done() {
                let _ = w.tx.send(close_done());
                done.push(*id);
            }
        }
        for id in done {
            self.watchers.remove(&id);
        }
    }

    fn join(&mut self, role: String, remote: String, watch: Option<(String, Watch)>, tx: UnboundedSender<Message>) -> u64 {
        self.next_id += 1;
        let id = self.next_id;

        if let Some((query, mut watch)) = watch {
            eprintln!("[bridge] watch connected from {remote}: {query}");
            for line in watch.on_message(&self.snapshot()) {
                let _ = tx.send(text(line));
            }
            if watch.done() {
                let _ = tx.send(close_done());
            } else {
                if !self.has_dashboard() {
                    // 黙っていると「まだ走っている」と区別がつかない
                    let _ = tx.send(text("watch: 拡張 (ダッシュボード) が bridge に繋がっていない — 繋がるまで変化は届かない"));
                }
                self.watchers.insert(id, Watcher { query, watch, tx });
            }
            return id;
        }

        eprintln!("[bridge] {role} connected from {remote} ({} total)", self.clients.len() + 1);
        if role == "listener" && !self.runs.is_empty() {
            let mut snap = self.snapshot();
            snap["cached"] = true.into();
            let _ = tx.send(text(snap.to_string()));
        }
        let back = role == "extension" && !self.has_dashboard();
        self.clients.insert(id, Client { role, remote, repos: Vec::new(), tx });
        if back {
            self.notify_watchers("watch: 拡張 (ダッシュボード) が bridge に繋がった");
        }
        id
    }

    fn leave(&mut self, id: u64) {
        if let Some(w) = self.watchers.remove(&id) {
            eprintln!("[bridge] watch gone: {}", w.query);
            return;
        }
        let Some(c) = self.clients.remove(&id) else { return };
        eprintln!("[bridge] {} gone ({} left)", c.role, self.clients.len());
        if c.role == "extension" && !self.has_dashboard() {
            self.notify_watchers("watch: 拡張 (ダッシュボード) が bridge から外れた — 戻るまで変化は届かない");
        }
    }

    fn on_extension_message(&mut self, id: u64, msg: &Value) {
        match msg["type"].as_str().unwrap_or("") {
            "hello" => {
                let repos: Vec<String> = msg["repos"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if let Some(c) = self.clients.get_mut(&id) {
                    eprintln!("[bridge] extension hello: repos={} v{} from {}", repos.join(","), field(msg, "version"), c.remote);
                    c.repos = repos;
                }
            }
            "pong" => {}
            "events" => {
                for e in msg["events"].as_array().into_iter().flatten() {
                    println!("{}", fmt_line(e, &field(e, "from"), &field(e, "label")));
                    let run = self.runs.entry(run_key(e)).or_insert_with(|| json!({}));
                    if let (Some(run), Some(ev)) = (run.as_object_mut(), e.as_object()) {
                        for (k, v) in ev {
                            if !matches!(k.as_str(), "from" | "label" | "t") {
                                run.insert(k.clone(), v.clone());
                            }
                        }
                        run.insert("status".into(), ev.get("label").cloned().unwrap_or(Value::Null));
                    }
                }
                self.feed_watchers(msg);
            }
            "snapshot" => {
                let list = msg["runs"].as_array().cloned().unwrap_or_default();
                // 置き換えずに重ねる。ダッシュボードは複数 (Windows と Linux) 繋がりうるうえ、起動直後は
                // 読み込み前の空の snapshot を送るので、置き換えると写しが 0 runs に戻る (#62)
                for r in &list {
                    self.runs.insert(run_key(r), r.clone());
                }
                let running = list.iter().filter(|r| is_active(&field(r, "status"))).count();
                let bad = list.iter().filter(|r| is_bad(&field(r, "status"))).count();
                let mut repos: Vec<String> = Vec::new();
                for r in &list {
                    let name = field(r, "repo");
                    if !repos.contains(&name) {
                        repos.push(name);
                    }
                }
                println!("snapshot: {} runs, {running} running, {bad} failed ({})", list.len(), repos.join(", "));
                self.feed_watchers(msg);
            }
            "log" => eprintln!("[bridge] extension log: {}", field(msg, "text")),
            _ => println!("{msg}"),
        }
        self.send_role(|r| r == "listener", msg); // 生のまま listener へ
    }

    /// `/mcp` の actions_dashboard に渡す形。repo の並びはダッシュボードが hello で送った設定の順
    fn dashboard(&self, q: &mcp::Query) -> Value {
        let mut order: Vec<String> = Vec::new();
        for c in self.clients.values().filter(|c| c.role == "extension") {
            for r in &c.repos {
                if !order.contains(r) {
                    order.push(r.clone());
                }
            }
        }
        mcp::dashboard(&order, &self.runs, self.has_dashboard(), q)
    }

    fn status(&self) -> Value {
        let clients: Vec<String> = self
            .clients
            .values()
            .map(|c| {
                if c.repos.is_empty() { format!("{}@{}", c.role, c.remote) } else { format!("{}@{} {}", c.role, c.remote, c.repos.join(",")) }
            })
            .collect();
        let watchers: Vec<&str> = self.watchers.values().map(|w| w.query.as_str()).collect();
        json!({ "ok": true, "port": self.port, "clients": clients, "watchers": watchers })
    }
}

fn close_done() -> Message {
    Message::Close(Some(CloseFrame { code: 1000, reason: "done".into() }))
}

/// 外へ出す MCP の合言葉の最短の長さ (推測されない長さ)
const MIN_MCP_TOKEN: usize = 32;

pub fn app(port: u16) -> Router {
    let token = std::env::var("GH_ACTIONS_BRIDGE_MCP_TOKEN").ok().filter(|t| t.len() >= MIN_MCP_TOKEN);
    eprintln!("[bridge] /mcp/<合言葉>: {}", if token.is_some() { "開いている" } else { "閉じている (GH_ACTIONS_BRIDGE_MCP_TOKEN が無いか 32 文字未満)" });
    build(port, Duration::from_secs(300), token)
}

pub fn app_with_refresh(port: u16, every: Duration) -> Router {
    build(port, every, None)
}

pub fn app_with_mcp_token(port: u16, token: &str) -> Router {
    build(port, Duration::from_secs(300), Some(token.to_string()))
}

fn build(port: u16, every: Duration, mcp_token: Option<String>) -> Router {
    let hub: Shared = Arc::new(Mutex::new(Hub {
        port,
        next_id: 0,
        clients: HashMap::new(),
        watchers: HashMap::new(),
        runs: HashMap::new(),
        mcp_token,
    }));
    tokio::spawn(keepalive(hub.clone()));
    tokio::spawn(auto_refresh(hub.clone(), every));
    Router::new()
        .route("/", get(root))
        .route("/watch", get(watch_ws))
        .route("/cmd", post(cmd))
        .route("/mcp", post(mcp_post).get(method_not_allowed).delete(method_not_allowed))
        .route("/mcp/{token}", post(mcp_public).get(method_not_allowed).delete(method_not_allowed))
        .layer(middleware::from_fn(cors))
        .layer(middleware::from_fn(tunnel_guard))
        .with_state(hub)
}

async fn root(
    State(hub): State<Shared>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<HashMap<String, String>>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    match ws {
        Ok(ws) => {
            let role = q.get("role").cloned().unwrap_or_else(|| "extension".into());
            ws.on_upgrade(move |s| serve(s, hub, role, addr.ip().to_string(), None))
        }
        Err(_) => Json(hub.lock().unwrap().status()).into_response(),
    }
}

async fn watch_ws(
    State(hub): State<Shared>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(pairs): Query<Vec<(String, String)>>,
    ws: WebSocketUpgrade,
) -> Response {
    let filter = match Filter::parse(&pairs) {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("{e}\n")).into_response(),
    };
    let query = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    ws.on_upgrade(move |s| serve(s, hub, "watch".into(), addr.ip().to_string(), Some((query, Watch::new(filter)))))
}

async fn cmd(State(hub): State<Shared>, body: String) -> Response {
    let Ok(Value::Object(cmd)) = serde_json::from_str::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "bad json\n").into_response();
    };
    let name = field(&Value::Object(cmd.clone()), "command");
    let mut payload = Map::new();
    payload.insert("type".into(), "command".into());
    payload.extend(cmd);
    let n = hub.lock().unwrap().send_role(is_ext, &Value::Object(payload));
    eprintln!("[bridge] cmd {name} -> {n} extension(s)");
    Json(json!({ "ok": true, "delivered_to": n })).into_response()
}

// 1 リクエスト = JSON-RPC 1 通 (配列ならバッチ)。応答が無い (通知だけ) なら 202
async fn mcp_post(State(hub): State<Shared>, body: String) -> Response {
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        let e = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return (StatusCode::BAD_REQUEST, Json(e)).into_response();
    };
    // どの method が来たかを journal に残す (ウィジェットの resource をホストが取りに来たかの切り分け用)
    let one = |r: &Value| {
        let name = r["params"]["name"].as_str().or(r["params"]["uri"].as_str()).unwrap_or("");
        eprintln!("[bridge] mcp {} {name}", r["method"].as_str().unwrap_or("?"));
        mcp::handle(r, |q| hub.lock().unwrap().dashboard(q))
    };
    let res = match &req {
        Value::Array(list) => {
            let out: Vec<Value> = list.iter().filter_map(one).collect();
            if out.is_empty() { None } else { Some(Value::Array(out)) }
        }
        r => one(r),
    };
    match res {
        Some(v) => Json(v).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

// Tunnel 越しの口。合言葉が違えば口が在ることも見せない (404)
async fn mcp_public(State(hub): State<Shared>, Path(token): Path<String>, body: String) -> Response {
    let ok = hub.lock().unwrap().mcp_token.as_deref().is_some_and(|t| same(t.as_bytes(), token.as_bytes()));
    if !ok {
        return StatusCode::NOT_FOUND.into_response();
    }
    mcp_post(State(hub), body).await
}

/// 長さ以外で早く抜けない比較 (合言葉を 1 文字ずつ当てられないように)
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// cloudflared は要求に cf-ray を付ける。Tunnel の ingress は /mcp/ だけを通す設定にするが、
// 設定を間違えても /cmd (拡張への任意コマンド) や /watch が外に出ないよう、bridge 側でも塞ぐ
async fn tunnel_guard(req: Request, next: Next) -> Response {
    if req.headers().contains_key("cf-ray") && !req.uri().path().starts_with("/mcp/") {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

// SSE の口も session も持たない (stateless)
async fn method_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn serve(socket: WebSocket, hub: Shared, role: String, remote: String, watch: Option<(String, Watch)>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Message>();
    let id = hub.lock().unwrap().join(role.clone(), remote, watch, tx);

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let last = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || last {
                break;
            }
        }
    });

    while let Some(Ok(m)) = stream.next().await {
        let t = match m {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let msg = serde_json::from_str(t.as_str()).unwrap_or_else(|_| json!({ "type": "raw", "text": t.as_str() }));
        let mut h = hub.lock().unwrap();
        if is_ext(&role) {
            h.on_extension_message(id, &msg);
        } else if role == "listener" {
            h.send_role(is_ext, &msg); // listener からのコマンド
        }
    }

    hub.lock().unwrap().leave(id);
    writer.abort();
}

// 20 秒ごとに拡張へ {"type":"ping"} を送る。MV3 の service worker は WebSocket の往来が
// 30 秒以内にあれば生き続けるので、これが keepalive になる。
// /watch には通知にならないよう WebSocket の Ping フレームを送る
async fn keepalive(hub: Shared) {
    let mut every = tokio::time::interval(Duration::from_secs(20));
    loop {
        every.tick().await;
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let ping = json!({ "type": "ping", "t": t }).to_string();
        let h = hub.lock().unwrap();
        for c in h.clients.values() {
            let _ = c.tx.send(text(ping.clone()));
        }
        for w in h.watchers.values() {
            let _ = w.tx.send(Message::Ping(Default::default()));
        }
    }
}

// alive socket が黙って変化を取りこぼしたときの保険。5 分ごとにダッシュボードへ
// {"type":"command","command":"refresh"} を送り、boot() で Actions ページを取り直させる。
// 送り先はダッシュボード (role == "extension") だけ — is_ext は extension-bg にも届くので使わない。
// 起動直後の即時 tick は捨てる (interval の最初の tick はすぐ来るため)
async fn auto_refresh(hub: Shared, every: Duration) {
    let mut every = tokio::time::interval(every);
    every.tick().await; // 起動直後の即時 tick を捨てる
    loop {
        every.tick().await;
        let msg = json!({ "type": "command", "command": "refresh" });
        hub.lock().unwrap().send_role(|r| r == "extension", &msg);
    }
}

async fn cors(req: Request, next: Next) -> Response {
    let mut res = if req.method() == Method::OPTIONS { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET,POST,OPTIONS"));
    res
}
