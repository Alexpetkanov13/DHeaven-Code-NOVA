use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUT: usize = 32 * 1024 * 1024;

async fn git(root: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(["-c", "core.quotepath=false", "-c", "color.ui=false"]).args(args)
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0").kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(TIMEOUT, cmd.output()).await.map_err(|_| anyhow::anyhow!("git timed out"))??;
    anyhow::ensure!(out.status.success(), "git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
    anyhow::ensure!(out.stdout.len() <= MAX_OUT, "git output too large");
    Ok(out.stdout)
}

fn check_rel(p: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!p.starts_with('/') && !p.starts_with('-') && !p.contains('\0') && !p.split(['/', '\\']).any(|s| s == "..") && !p.contains(':'), "invalid path");
    Ok(())
}

#[derive(Deserialize)]
pub struct Root { root: String }

/// Parses `git status --porcelain=v2 -z --branch`.
pub fn parse_status(raw: &[u8]) -> Value {
    let s = String::from_utf8_lossy(raw);
    let mut parts = s.split('\0').filter(|x| !x.is_empty()).peekable();
    let mut branch = Value::Null;
    let mut files = vec![];
    while let Some(rec) = parts.next() {
        if let Some(b) = rec.strip_prefix("# branch.head ") { branch = json!(b); continue; }
        if rec.starts_with('#') { continue; }
        let kind = rec.as_bytes()[0];
        match kind {
            b'1' | b'2' => {
                let n = if kind == b'1' { 8 } else { 9 };
                let f: Vec<&str> = rec.splitn(n + 1, ' ').collect();
                let xy = f.get(1).copied().unwrap_or("..");
                let path = f.get(n).copied().unwrap_or("").to_string();
                if kind == b'2' { parts.next(); } // original path for renames
                files.push(json!({"path": path, "index": &xy[0..1], "worktree": &xy[1..2]}));
            }
            b'?' => files.push(json!({"path": &rec[2..], "index": "?", "worktree": "?"})),
            b'u' => { let f: Vec<&str> = rec.splitn(11, ' ').collect(); files.push(json!({"path": f.get(10).copied().unwrap_or(""), "index": "U", "worktree": "U"})); }
            _ => {}
        }
    }
    json!({"branch": branch, "files": files})
}

pub async fn status(p: Root) -> anyhow::Result<Value> {
    if git(&p.root, &["rev-parse", "--is-inside-work-tree"]).await.is_err() { return Ok(json!({"isRepo": false, "branch": null, "files": []})); }
    let mut v = parse_status(&git(&p.root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]).await?);
    v["isRepo"] = json!(true);
    Ok(v)
}

#[derive(Deserialize)]
pub struct Show { root: String, path: String, rev: String }
/// rev: "HEAD" or "INDEX". Missing file -> empty string.
pub async fn show(p: Show) -> anyhow::Result<Value> {
    check_rel(&p.path)?;
    let spec = match p.rev.as_str() { "HEAD" => format!("HEAD:{}", p.path), "INDEX" => format!(":{}", p.path), _ => anyhow::bail!("bad rev") };
    Ok(json!({"content": git(&p.root, &["show", &spec]).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()}))
}

#[derive(Deserialize)]
pub struct Paths { root: String, paths: Vec<String> }
pub async fn stage(p: Paths, add: bool) -> anyhow::Result<Value> {
    for x in &p.paths { check_rel(x)?; }
    let mut args: Vec<&str> = if add { vec!["add", "-A", "--"] } else { vec!["restore", "--staged", "--"] };
    args.extend(p.paths.iter().map(String::as_str));
    if !add && git(&p.root, &["rev-parse", "--verify", "HEAD"]).await.is_err() {
        args = vec!["rm", "--cached", "-r", "-q", "--"]; args.extend(p.paths.iter().map(String::as_str)); // no commits yet
    }
    git(&p.root, &args).await?;
    Ok(json!(null))
}

#[derive(Deserialize)]
pub struct Commit { root: String, message: String }
pub async fn commit(p: Commit) -> anyhow::Result<Value> {
    anyhow::ensure!(!p.message.trim().is_empty(), "empty commit message");
    git(&p.root, &["commit", "-m", &p.message]).await?;
    let h = git(&p.root, &["rev-parse", "--short", "HEAD"]).await?;
    Ok(json!({"commit": String::from_utf8_lossy(&h).trim()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_porcelain_v2() {
        let raw = b"# branch.oid abc\0# branch.head main\x001 M. N... 100644 100644 100644 a b src/a.ts\x001 .M N... 100644 100644 100644 a b my file.txt\0? new.txt\0";
        let v = parse_status(raw);
        assert_eq!(v["branch"], "main");
        assert_eq!(v["files"][0]["path"], "src/a.ts");
        assert_eq!(v["files"][0]["index"], "M");
        assert_eq!(v["files"][1]["path"], "my file.txt");
        assert_eq!(v["files"][1]["worktree"], "M");
        assert_eq!(v["files"][2]["index"], "?");
    }
    #[test]
    fn rejects_bad_paths() {
        for p in ["../x", "/etc", "-rf", "a/../../b", "C:x"] { assert!(check_rel(p).is_err(), "{p}"); }
        assert!(check_rel("src/a.ts").is_ok());
    }
    #[tokio::test]
    async fn stage_commit_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().to_string_lossy().to_string();
        git(&r, &["init", "-q"]).await.unwrap();
        git(&r, &["config", "user.email", "t@example.com"]).await.unwrap();
        git(&r, &["config", "user.name", "T"]).await.unwrap();
        std::fs::write(d.path().join("f.txt"), "1").unwrap();
        stage(Paths { root: r.clone(), paths: vec!["f.txt".into()] }, true).await.unwrap();
        let s = status(Root { root: r.clone() }).await.unwrap();
        assert_eq!(s["files"][0]["index"], "A");
        stage(Paths { root: r.clone(), paths: vec!["f.txt".into()] }, false).await.unwrap();
        assert_eq!(status(Root { root: r.clone() }).await.unwrap()["files"][0]["index"], "?");
        stage(Paths { root: r.clone(), paths: vec!["f.txt".into()] }, true).await.unwrap();
        let c = commit(Commit { root: r.clone(), message: "init".into() }).await.unwrap();
        assert!(c["commit"].as_str().unwrap().len() >= 7);
        assert_eq!(status(Root { root: r.clone() }).await.unwrap()["files"].as_array().unwrap().len(), 0);
        let shown = show(Show { root: r, path: "f.txt".into(), rev: "HEAD".into() }).await.unwrap();
        assert_eq!(shown["content"], "1");
    }
}
