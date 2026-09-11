//! `/watch` の絞り込み。1 接続 = 1 [`Watch`]。拡張から来た events / snapshot を受けて、
//! 出すべき行 (前回出した状態から変わったものだけ) を返す。

use std::collections::HashMap;

use serde_json::Value;

/// JSON の文字列 / 数値をどちらも文字列で読む (run は文字列で来るが、数値でも同じに扱う)
pub fn field(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn contains_any(status: &str, words: &[&str]) -> bool {
    let s = status.to_lowercase();
    words.iter().any(|w| s.contains(w))
}

/// まだ終わっていない状態 (実測: "queued" / "currently running" / "waiting")
pub fn is_active(status: &str) -> bool {
    contains_any(status, &["running", "queued", "progress", "waiting", "pending", "requested"])
}

pub fn is_bad(status: &str) -> bool {
    contains_any(status, &["fail", "cancel", "timed", "error"])
}

/// run の同一性。run 番号は workflow ごとなので workflow も入れる
pub fn run_key(r: &Value) -> String {
    format!("{}#{}#{}", field(r, "repo"), field(r, "workflow"), field(r, "run"))
}

/// 通知 1 行: `<repo> <workflow> #<run>: <from> → <to> [<ref>] — <title>`
pub fn fmt_line(e: &Value, from: &str, label: &str) -> String {
    let arrow = if from.is_empty() { label.to_string() } else { format!("{from} → {label}") };
    let git_ref = field(e, "ref");
    let tag = if git_ref.is_empty() { String::new() } else { format!(" [{git_ref}]") };
    let title = field(e, "title");
    let title = if title.is_empty() { String::new() } else { format!(" — {}", title.chars().take(80).collect::<String>()) };
    format!("{} {} #{}: {arrow}{tag}{title}", field(e, "repo"), field(e, "workflow"), field(e, "run"))
}

/// 同じ key を重ねると OR、違う key は AND
#[derive(Debug, Default)]
pub struct Filter {
    repo: Vec<String>,
    git_ref: Vec<String>,
    run: Vec<String>,
    workflow: Vec<String>,
    by: Vec<String>,
    all: bool,
}

impl Filter {
    pub fn parse(pairs: &[(String, String)]) -> Result<Self, String> {
        let mut f = Self::default();
        for (k, v) in pairs {
            let list = match k.as_str() {
                "repo" => &mut f.repo,
                "ref" => &mut f.git_ref,
                "run" => &mut f.run,
                "workflow" => &mut f.workflow,
                "by" => &mut f.by,
                "all" => {
                    f.all = true;
                    continue;
                }
                _ => return Err(format!("知らない条件: {k} (repo / ref / run / workflow / by / all)")),
            };
            if !v.is_empty() {
                list.push(v.clone());
            }
        }
        let none = [&f.repo, &f.git_ref, &f.run, &f.workflow, &f.by].iter().all(|l| l.is_empty());
        if none && !f.all {
            // 全量が流れるとセッションの通知が埋まる。明示したときだけ許す
            return Err("条件が無い。repo / ref / run / workflow / by のどれかを付ける (全部見るなら all=1)".into());
        }
        Ok(f)
    }

    pub fn matches(&self, r: &Value) -> bool {
        let exact = |list: &[String], v: String| list.is_empty() || list.contains(&v);
        let git_ref = field(r, "ref");
        let workflow = field(r, "workflow").to_lowercase();
        exact(&self.repo, field(r, "repo"))
            // 拡張が ref を 40 文字で切るので、こちらも先頭 40 文字で比べる
            && (self.git_ref.is_empty() || self.git_ref.iter().any(|x| x.chars().take(40).collect::<String>() == git_ref))
            && exact(&self.run, field(r, "run"))
            && (self.workflow.is_empty() || self.workflow.iter().any(|x| workflow.contains(&x.to_lowercase())))
            && exact(&self.by, field(r, "by"))
    }
}

pub struct Watch {
    filter: Filter,
    /// run_key -> (run 番号, 最後に出した状態)
    seen: HashMap<String, (String, String)>,
}

impl Watch {
    pub fn new(filter: Filter) -> Self {
        Self { filter, seen: HashMap::new() }
    }

    pub fn on_message(&mut self, msg: &Value) -> Vec<String> {
        let mut out = Vec::new();
        match msg["type"].as_str() {
            Some("events") => {
                for e in msg["events"].as_array().into_iter().flatten() {
                    if self.filter.matches(e) {
                        self.emit(e, &field(e, "from"), &field(e, "label"), &mut out);
                    }
                }
            }
            Some("snapshot") => {
                // 終わった過去の run は出さない。run 指定か、前に出した run (切断中に終わった) だけは出す
                for r in msg["runs"].as_array().into_iter().flatten() {
                    let status = field(r, "status");
                    if self.filter.matches(r)
                        && (is_active(&status) || !self.filter.run.is_empty() || self.seen.contains_key(&run_key(r)))
                    {
                        self.emit(r, "", &status, &mut out);
                    }
                }
            }
            _ => {}
        }
        out
    }

    // 前回出した状態と違うときだけ出す (拡張が繋ぎ直して同じ snapshot が来ても二重に出さない)
    fn emit(&mut self, e: &Value, from: &str, status: &str, out: &mut Vec<String>) {
        let key = run_key(e);
        let prev = self.seen.get(&key).map(|(_, s)| s.clone());
        if prev.as_deref() == Some(status) {
            return;
        }
        let from = prev.unwrap_or_else(|| from.to_string());
        self.seen.insert(key, (field(e, "run"), status.to_string()));
        out.push(fmt_line(e, &from, status));
    }

    /// run 指定の番号が全部見えていて、見えたものが全部終わっている
    pub fn done(&self) -> bool {
        !self.filter.run.is_empty()
            && self.filter.run.iter().all(|n| {
                let mut hits = self.seen.values().filter(|(run, _)| run == n).peekable();
                hits.peek().is_some() && hits.all(|(_, s)| !is_active(s))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn watch(q: &[(&str, &str)]) -> Watch {
        let pairs: Vec<_> = q.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Watch::new(Filter::parse(&pairs).unwrap())
    }

    fn snap() -> Value {
        json!({ "type": "snapshot", "runs": [
            { "repo": "ippoan/x", "workflow": "CI", "run": "10", "status": "currently running", "ref": "feat-a", "title": "t" },
            { "repo": "ippoan/y", "workflow": "CI", "run": "5", "status": "currently running", "ref": "feat-b", "title": "u" },
            { "repo": "ippoan/x", "workflow": "CI", "run": "9", "status": "completed successfully", "ref": "feat-a", "title": "s" },
        ] })
    }

    #[test]
    fn run_shows_current_state_ignores_other_repos_and_finishes() {
        let mut w = watch(&[("repo", "ippoan/x"), ("workflow", "ci"), ("run", "10")]);
        assert_eq!(w.on_message(&snap()), ["ippoan/x CI #10: currently running [feat-a] — t"]);
        assert!(!w.done());
        let ev = json!({ "type": "events", "events": [
            { "repo": "ippoan/y", "workflow": "CI", "run": "5", "from": "currently running", "label": "failed", "ref": "feat-b" },
            { "repo": "ippoan/x", "workflow": "CI", "run": "10", "from": "currently running", "label": "completed successfully", "ref": "feat-a", "title": "t" },
        ] });
        assert_eq!(w.on_message(&ev), ["ippoan/x CI #10: currently running → completed successfully [feat-a] — t"]);
        assert!(w.done());
    }

    #[test]
    fn already_finished_run_is_done_immediately() {
        let mut w = watch(&[("repo", "ippoan/x"), ("run", "9")]);
        assert_eq!(w.on_message(&snap()), ["ippoan/x CI #9: completed successfully [feat-a] — s"]);
        assert!(w.done());
    }

    #[test]
    fn ref_only_shows_active_runs_from_snapshot_and_never_finishes() {
        let mut w = watch(&[("ref", "feat-a")]);
        assert_eq!(w.on_message(&snap()), ["ippoan/x CI #10: currently running [feat-a] — t"]);
        assert!(!w.done());
    }

    #[test]
    fn repeated_snapshot_is_quiet_but_runs_finished_while_away_are_shown() {
        let mut w = watch(&[("ref", "feat-a")]);
        w.on_message(&snap());
        assert!(w.on_message(&snap()).is_empty());
        let mut s = snap();
        s["runs"][0]["status"] = "failed".into();
        assert_eq!(w.on_message(&s), ["ippoan/x CI #10: currently running → failed [feat-a] — t"]);
    }

    #[test]
    fn ref_is_compared_by_first_40_chars() {
        let long = "a".repeat(50);
        let mut w = watch(&[("ref", &long)]);
        let ev = json!({ "type": "events", "events": [
            { "repo": "o/r", "workflow": "CI", "run": "1", "label": "queued", "ref": "a".repeat(40) },
        ] });
        assert_eq!(w.on_message(&ev).len(), 1);
    }

    #[test]
    fn rejects_missing_or_unknown_conditions() {
        assert!(Filter::parse(&[]).is_err());
        assert!(Filter::parse(&[("repo".into(), String::new())]).is_err());
        assert!(Filter::parse(&[("branch".into(), "x".into())]).is_err());
        assert!(Filter::parse(&[("all".into(), "1".into())]).is_ok());
    }
}
