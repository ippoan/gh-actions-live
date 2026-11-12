//! `POST /mcp` — bridge が持っている全 repo の run を、MCP のツール 1 本と MCP Apps のビュー
//! (Claude の会話の中に出るウィジェット) で見せる (Refs #62)。
//!
//! - Streamable HTTP の stateless な JSON 応答だけを実装する (SSE も session も持たない)。
//!   リクエスト 1 本 = JSON-RPC 1 通 (配列のバッチも受ける)
//! - データは拡張 (ログイン済みのブラウザ) が流した snapshot / events の写しだけ。
//!   **GitHub の API は叩かない** (レート制限に当てない。ユーザーの決定)
//! - モデルに見せるツール (`actions_dashboard`) は要約のテキストだけを返す。Claude Code は
//!   `structuredContent` があると text の代わりにそれをモデルへ渡し、42 repo 分 (9 万字) が毎回
//!   上限超えでファイルに退避された (#62 の実機確認)。repo ごとの run はビュー専用のツール
//!   (`actions_dashboard_data`、`_meta.ui.visibility = ["app"]`) の `structuredContent` で渡す
//! - ビューは sandbox の iframe で動き、5 秒ごとにホスト経由の `tools/call` でビュー専用のツールを呼ぶ。
//!   iframe は Claude のデスクトップアプリ (Windows) 側に出るので、Linux の bridge へ直接 ws は張らない
//! - 書き込みの口は無い (読み取り専用)。8799 に届く者には今でも `GET /` で同じ程度の情報が見えている

use std::cmp::Reverse;
use std::collections::HashMap;

use serde_json::{Value, json};

use crate::watch::{field, is_active, is_bad};

pub const TOOL: &str = "actions_dashboard";
/// ビュー専用 (モデルには出さない)。repo ごとの run を structuredContent で返す
pub const DATA_TOOL: &str = "actions_dashboard_data";
/// actions_dashboard の結果の `_meta` に載せるウィジェット用データのキー (dashboard.html と同じ)
pub const META_KEY: &str = "gh-actions-live/dashboard";
/// ウィジェットの URI。HTML のハッシュを入れる: Claude のアプリはウィジェットを URI ごとにセッションを
/// またいで使い回すので、URI が同じだと直した HTML が描かれない (#62。読み出しは来るのに古い版が出た)
pub fn view_uri() -> String {
    format!("ui://gh-actions-live/dashboard-{:07x}.html", view_hash())
}
/// MCP Apps の HTML リソースの mimeType (ext-apps の RESOURCE_MIME_TYPE と同値)
pub const MIME: &str = "text/html;profile=mcp-app";
const VIEW_HTML: &str = include_str!("../widget/dashboard.html");
/// repo ごとに返す run の上限 (拡張のダッシュボードの MAX_CARDS_PER_REPO と同じ)
pub const MAX_RUNS_PER_REPO: usize = 7;
/// 知らない版を言われたときに返す版
const LATEST_PROTOCOL: &str = "2025-06-18";
const PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// ビューは外から何も読まない (ext-apps も CDN から読まず、ホストとの通信を HTML の中に持つ)
/// ウィジェットの版: bridge の版 + HTML の中身のハッシュ (先頭 7 桁)。見出しに出して、ホストが古い HTML を
/// 使い回していないかを画面で見分ける (Claude のアプリはセッション中に読み直さない、#62)
pub fn view_version() -> String {
    format!("v{}+{:07x}", env!("CARGO_PKG_VERSION"), view_hash())
}

/// HTML の中身のハッシュ (先頭 28 bit)。FNV-1a: HTML が変われば変わればよいので暗号的な強さは要らない
fn view_hash() -> u64 {
    VIEW_HTML.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)) >> 36
}

pub fn view_html() -> String {
    VIEW_HTML.replace("__WIDGET_VERSION__", &view_version())
}

/// 拡張のダッシュボードの `cls()` と同じ分類: ok / run / bad / idle
pub fn state_class(status: &str) -> &'static str {
    let s = status.to_lowercase();
    if s.contains("success") {
        "ok"
    } else if is_active(&s) {
        "run"
    } else if is_bad(&s) || s.contains("action required") {
        "bad"
    } else {
        "idle"
    }
}

fn run_time(r: &Value) -> String {
    let at = field(r, "at");
    if at.is_empty() { field(r, "seenAt") } else { at }
}

/// ツールの引数のうち絞り込み。`repo`: repo 名 (完全一致か `owner/` を省いた名前の一致を優先し、無ければ部分一致)。
/// `since`: この時刻 (ISO 8601、UTC の `Z` 付き) 以降に始まった run だけ。PR を出した repo をその時刻から見る用
#[derive(Default)]
pub struct Query<'a> {
    pub repo: Option<&'a str>,
    pub since: Option<&'a str>,
}

impl<'a> Query<'a> {
    pub fn from_args(args: &'a Value) -> Self {
        let get = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
        Self { repo: get("repo"), since: get("since") }
    }
}

/// ビューに渡す形。repo ごとに 実行中 → 新しい順 で並べ、上限で切る。
/// repo の並びは直近に run が動いた順 (run の無い repo は末尾、同時刻は `order` の順)
pub fn dashboard(order: &[String], runs: &HashMap<String, Value>, connected: bool, q: &Query) -> Value {
    let mut by_repo: Vec<(String, Vec<&Value>)> = order.iter().map(|r| (r.clone(), Vec::new())).collect();
    for r in runs.values() {
        let repo = field(r, "repo");
        match by_repo.iter_mut().find(|(name, _)| *name == repo) {
            Some((_, list)) => list.push(r),
            None => by_repo.push((repo, vec![r])),
        }
    }
    if let Some(f) = q.repo.map(str::to_lowercase) {
        let exact = |name: &str| { let n = name.to_lowercase(); n == f || n.rsplit('/').next() == Some(f.as_str()) };
        if by_repo.iter().any(|(name, _)| exact(name)) {
            by_repo.retain(|(name, _)| exact(name));
        } else {
            by_repo.retain(|(name, _)| name.to_lowercase().contains(&f));
        }
    }
    if let Some(since) = q.since {
        // 時刻は ISO 8601 の文字列なので文字列で比べる。その時刻以降の run が無い repo は出さない。
        // 時刻の無い run は残す: 拡張の push (events) で新しく現れた run には at が無く (snapshot の行にしか無い)、
        // それはまさに PR を出した直後の CI なので落とすと肝心の run が消える (#62、CI #122 で踏んだ)
        for (_, list) in by_repo.iter_mut() {
            list.retain(|r| { let t = run_time(r); t.is_empty() || t.as_str() >= since });
        }
        by_repo.retain(|(_, list)| !list.is_empty());
    }
    let latest = |list: &Vec<&Value>| list.iter().map(|r| run_time(r)).max().unwrap_or_default();
    by_repo.sort_by_cached_key(|(_, list)| Reverse(latest(list))); // 安定ソート: 同時刻は元の順

    let mut total = 0;
    let repos: Vec<Value> = by_repo
        .into_iter()
        .map(|(repo, mut list)| {
            list.sort_by_cached_key(|r| (state_class(&field(r, "status")) != "run", Reverse(run_time(r))));
            let active = list.iter().filter(|r| state_class(&field(r, "status")) == "run").count();
            let bad = list.iter().filter(|r| state_class(&field(r, "status")) == "bad").count();
            total += list.len();
            json!({
                "repo": repo, "total": list.len(), "active": active, "bad": bad,
                "runs": list.iter().take(MAX_RUNS_PER_REPO).map(|r| json!({
                    "workflow": field(r, "workflow"), "run": field(r, "run"), "status": field(r, "status"),
                    "state": state_class(&field(r, "status")), "title": field(r, "title"), "ref": field(r, "ref"),
                    "by": field(r, "by"), "href": field(r, "href"), "at": field(r, "at"), "duration": field(r, "duration"),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "connected": connected, "totalRuns": total, "repos": repos })
}

/// モデルに見せる要約。実行中の run と、workflow ごとの最新が赤のものだけを並べる
pub fn summary(d: &Value) -> String {
    let repos = d["repos"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![format!(
        "{} repos · {} runs · {}",
        repos.len(),
        d["totalRuns"],
        if d["connected"].as_bool() == Some(true) { "拡張は bridge に接続中" } else { "拡張 (ダッシュボード) が bridge に繋がっていない — 表示は最後に届いた状態" }
    )];
    for r in &repos {
        let mut seen = Vec::new();
        for run in r["runs"].as_array().into_iter().flatten() {
            let wf = field(run, "workflow");
            let first = !seen.contains(&wf);
            seen.push(wf.clone());
            let st = field(run, "state");
            if st == "run" || (st == "bad" && first) {
                lines.push(format!("{} {} #{}: {} [{}] — {}", field(r, "repo"), wf, field(run, "run"), field(run, "status"), field(run, "ref"), field(run, "title")));
            }
        }
    }
    lines.join("\n")
}

fn repo_arg() -> Value {
    json!({
        "type": "object",
        "properties": {
            "repo": { "type": "string", "description": "repo で絞る (例: alc-app か ippoan/alc-app)。完全一致があればそれだけ、無ければ部分一致。省略すると全 repo" },
            "since": { "type": "string", "description": "この時刻以降に始まった run だけ (ISO 8601、UTC の Z 付き。例: 2026-11-12T13:00:00Z)。PR を出した repo をその時刻から見るときに repo と一緒に渡す" }
        },
        "additionalProperties": false
    })
}

fn tool_defs() -> Value {
    json!([
        {
            "name": TOOL,
            "title": "GitHub Actions ダッシュボード",
            "description": "watch 中の全 repo の GitHub Actions の run (実行中・失敗・経過時間) を、拡張のダッシュボードと同じ見た目のウィジェットで出す。\
結果のテキストは実行中の run と workflow ごとの最新が赤の run だけの要約。\
データはログイン済みのブラウザ (gh-actions-live 拡張) が bridge に流したもので、GitHub の API は叩かない。ウィジェットは 5 秒ごとに更新される。",
            "inputSchema": repo_arg(),
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
            "_meta": { "ui": { "resourceUri": view_uri() }, "ui/resourceUri": view_uri() }
        },
        {
            "name": DATA_TOOL,
            "title": "GitHub Actions ダッシュボードのデータ (ウィジェット用)",
            "description": "actions_dashboard のウィジェットが更新に使う。repo ごとの run を JSON で返す (大きいのでモデルからは呼ばない)",
            "inputSchema": repo_arg(),
            "annotations": { "readOnlyHint": true, "openWorldHint": false },
            "_meta": { "ui": { "resourceUri": view_uri(), "visibility": ["app"] } }
        }
    ])
}

fn ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// JSON-RPC 1 通を処理する。通知 (id 無し) は None。`data` はツールが呼ばれたときだけ評価する
pub fn handle(req: &Value, data: impl FnOnce(&Query) -> Value) -> Option<Value> {
    let id = req.get("id")?.clone();
    let params = &req["params"];
    let res = match req["method"].as_str().unwrap_or("") {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = if PROTOCOLS.contains(&asked) { asked } else { LATEST_PROTOCOL };
            ok(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": {}, "resources": {} },
                "serverInfo": { "name": "gh-actions-live", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "GitHub Actions の run の一覧を見るときは actions_dashboard を呼ぶ (ウィジェットが出る)。CI の完了を待つ見張りは従来どおり ws /watch の Monitor で。"
            }))
        }
        "ping" => ok(&id, json!({})),
        "tools/list" => ok(&id, json!({ "tools": tool_defs() })),
        "tools/call" => {
            let q = Query::from_args(&params["arguments"]);
            match params["name"].as_str() {
                // モデル向け: 要約だけ (structuredContent を付けるとそちらがモデルに渡る)
                // ウィジェットには _meta で同じデータを渡す (_meta はモデルに渡らない)。Claude Code のホストは
                // ウィジェットからの tools/call を受けない ("Method not found") ので、表示はこの結果だけで描く
                Some(TOOL) => {
                    let d = data(&q);
                    ok(&id, json!({ "content": [{ "type": "text", "text": summary(&d) }], "_meta": { META_KEY: d } }))
                }
                Some(DATA_TOOL) => {
                    let d = data(&q);
                    ok(&id, json!({ "content": [{ "type": "text", "text": summary(&d) }], "structuredContent": d }))
                }
                _ => return Some(err(&id, -32602, format!("知らないツール: {}", params["name"]))),
            }
        }
        "resources/list" => ok(&id, json!({ "resources": [{
            "uri": view_uri(), "name": "GitHub Actions dashboard view", "mimeType": MIME,
            "description": "actions_dashboard の結果を repo ごとの列で出すビュー"
        }] })),
        "resources/templates/list" => ok(&id, json!({ "resourceTemplates": [] })),
        "resources/read" => {
            if params["uri"].as_str() != Some(view_uri().as_str()) {
                return Some(err(&id, -32002, format!("知らないリソース: {}", params["uri"])));
            }
            ok(&id, json!({ "contents": [{
                "uri": view_uri(), "mimeType": MIME, "text": view_html(),
                "_meta": { "ui": { "prefersBorder": true } }
            }] }))
        }
        m => err(&id, -32601, format!("知らない method: {m}")),
    };
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs() -> HashMap<String, Value> {
        [
            json!({ "repo": "o/a", "workflow": "CI", "run": "1", "status": "completed successfully", "at": "2026-11-12T01:00:00Z" }),
            json!({ "repo": "o/a", "workflow": "CI", "run": "2", "status": "failed", "at": "2026-11-12T02:00:00Z" }),
            json!({ "repo": "o/b", "workflow": "CI", "run": "7", "status": "currently running", "at": "2026-11-12T00:30:00Z" }),
            json!({ "repo": "o/b", "workflow": "Deploy", "run": "3", "status": "completed successfully", "at": "2026-11-12T03:00:00Z" }),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, r)| (i.to_string(), r))
        .collect()
    }

    #[test]
    fn classifies_like_the_extension() {
        assert_eq!(state_class("completed successfully"), "ok");
        assert_eq!(state_class("currently running"), "run");
        assert_eq!(state_class("queued"), "run");
        assert_eq!(state_class("failed"), "bad");
        assert_eq!(state_class("cancelled"), "bad");
        assert_eq!(state_class("action required"), "bad");
        assert_eq!(state_class("skipped"), "idle");
    }

    #[test]
    fn repos_by_recent_runs_active_first_and_empty_repos_last() {
        let order = vec!["o/empty".to_string(), "o/a".to_string(), "o/b".to_string()];
        let d = dashboard(&order, &runs(), true, &Query::default());
        let names: Vec<_> = d["repos"].as_array().unwrap().iter().map(|r| field(r, "repo")).collect();
        assert_eq!(names, ["o/b", "o/a", "o/empty"]);
        let b = &d["repos"][0];
        assert_eq!(field(&b["runs"][0], "run"), "7"); // 実行中が古くても上
        assert_eq!((b["active"].as_u64(), b["bad"].as_u64()), (Some(1), Some(0)));
        assert_eq!(field(&d["repos"][1]["runs"][0], "run"), "2"); // 新しい順
        assert_eq!(d["totalRuns"], 4);
    }

    #[test]
    fn caps_runs_per_repo_and_filters_by_repo() {
        let many: HashMap<String, Value> = (0..20)
            .map(|i| (i.to_string(), json!({ "repo": "o/a", "workflow": "CI", "run": i.to_string(), "status": "completed successfully", "at": format!("2026-11-12T00:{i:02}:00Z") })))
            .collect();
        let d = dashboard(&[], &many, true, &Query::default());
        assert_eq!(d["repos"][0]["runs"].as_array().unwrap().len(), MAX_RUNS_PER_REPO);
        assert_eq!(d["repos"][0]["total"], 20);
        assert_eq!(dashboard(&[], &runs(), true, &Query { repo: Some("B"), since: None })["repos"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn repo_prefers_exact_match_and_since_drops_older_runs() {
        let mut rs = runs();
        rs.insert("x".into(), json!({ "repo": "o/a-s3", "workflow": "CI", "run": "1", "status": "failed", "at": "2026-11-12T05:00:00Z" }));
        let names = |d: &Value| d["repos"].as_array().unwrap().iter().map(|r| field(r, "repo")).collect::<Vec<_>>();
        // "a" は o/a に完全一致 (owner を省いた名前) するので o/a-s3 は出さない
        assert_eq!(names(&dashboard(&[], &rs, true, &Query { repo: Some("a"), since: None })), ["o/a"]);
        // 完全一致が無ければ部分一致
        assert_eq!(names(&dashboard(&[], &rs, true, &Query { repo: Some("a-s"), since: None })), ["o/a-s3"]);
        // since 以降の run だけ。残らない repo は出さない
        let d = dashboard(&[], &rs, true, &Query { repo: None, since: Some("2026-11-12T02:00:00Z") });
        assert_eq!(names(&d), ["o/a-s3", "o/b", "o/a"]);
        assert_eq!(d["repos"][2]["runs"].as_array().unwrap().len(), 1, "o/a は 02:00 の run だけ");
        // 時刻の無い run (push で新しく現れたもの) は since で絞っても残す
        rs.insert("y".into(), json!({ "repo": "o/c", "workflow": "CI", "run": "9", "status": "queued" }));
        let d = dashboard(&[], &rs, true, &Query { repo: Some("c"), since: Some("2026-11-12T23:00:00Z") });
        assert_eq!(names(&d), ["o/c"]);
        let d = dashboard(&[], &rs, true, &Query { repo: Some("ippoan/none"), since: None });
        assert!(d["repos"].as_array().unwrap().is_empty());
    }

    #[test]
    fn summary_lists_running_and_latest_failures_only() {
        let s = summary(&dashboard(&[], &runs(), false, &Query::default()));
        assert!(s.contains("o/b CI #7: currently running"), "{s}");
        assert!(s.contains("o/a CI #2: failed"), "{s}");
        assert!(!s.contains("#1:") && !s.contains("#3:"), "{s}");
        assert!(s.contains("繋がっていない"));
    }

    #[test]
    fn jsonrpc_flow() {
        let call = |m: &str, p: Value| handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": m, "params": p }), |_: &Query| json!({ "repos": [], "totalRuns": 0, "connected": true })).unwrap();
        assert_eq!(call("initialize", json!({ "protocolVersion": "2025-03-26" }))["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(call("initialize", json!({ "protocolVersion": "1999-01-01" }))["result"]["protocolVersion"], LATEST_PROTOCOL);
        let tools = call("tools/list", json!({}));
        assert_eq!(tools["result"]["tools"][0]["_meta"]["ui"]["resourceUri"], view_uri());
        assert!(view_uri().starts_with("ui://gh-actions-live/dashboard-") && view_uri().ends_with(".html"));
        assert_eq!(tools["result"]["tools"][1]["_meta"]["ui"]["visibility"], json!(["app"]));
        let model = call("tools/call", json!({ "name": TOOL, "arguments": {} }));
        assert!(model["result"].get("structuredContent").is_none(), "モデル向けに JSON を渡さない");
        assert!(model["result"]["_meta"][META_KEY]["repos"].is_array(), "ウィジェットには _meta で渡す");
        assert!(model["result"]["content"][0]["text"].as_str().unwrap().contains("repos"));
        assert!(call("tools/call", json!({ "name": DATA_TOOL, "arguments": {} }))["result"]["structuredContent"].is_object());
        assert_eq!(call("tools/call", json!({ "name": "nope" }))["error"]["code"], -32602);
        let html = call("resources/read", json!({ "uri": view_uri() }));
        let text = html["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(text.contains("ui/initialize") && !text.contains("https://cdn."), "外から何も読まない");
        assert!(text.contains(&view_version()) && !text.contains("__WIDGET_VERSION__"), "見出しに版を出す");
        assert_eq!(call("bogus", json!({}))["error"]["code"], -32601);
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), |_: &Query| Value::Null).is_none());
    }
}
