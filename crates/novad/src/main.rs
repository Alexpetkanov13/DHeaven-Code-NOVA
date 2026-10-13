//! novad — NOVA native daemon. Newline-delimited JSON-RPC over stdio.
//! Request: {"id":1,"method":"...","params":{...}}  Response: {"id":1,"result":...} | {"id":1,"error":{"code":"...","message":"..."}}
//! Notification (daemon -> main): {"method":"...","params":{...}}
mod git;
mod pty;
mod rpc;
mod search;

use rpc::Out;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let out = Out::stdout();
    let state = Arc::new(State::default());
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.len() > 64 * 1024 * 1024 { continue; }
        let msg: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let (out, state) = (out.clone(), state.clone());
        tokio::spawn(async move {
            let res = dispatch(&method, params, &out, &state).await;
            let reply = match res {
                Ok(v) => json!({"id": id, "result": v}),
                Err(e) => json!({"id": id, "error": {"code": "INTERNAL", "message": format!("{e:#}")}}),
            };
            out.send(reply);
        });
    }
    Ok(()) // stdin closed: parent went away -> exit (children are killed on drop)
}

#[derive(Default)]
pub struct State {
    pub searches: search::Registry,
    pub ptys: pty::Registry,
}

async fn dispatch(method: &str, p: Value, out: &Out, st: &Arc<State>) -> anyhow::Result<Value> {
    match method {
        "ping" => Ok(json!("pong")),
        "search.start" => search::start(serde_json::from_value(p)?, out.clone(), st),
        "search.cancel" => { search::cancel(st, p["searchId"].as_u64().unwrap_or(0)); Ok(json!(null)) }
        "files.list" => {
            let (files, truncated) = search::list_files(p["root"].as_str().unwrap_or(""), p["max"].as_u64().unwrap_or(50_000) as usize);
            Ok(json!({"files": files, "truncated": truncated}))
        }
        "pty.spawn" => pty::spawn(serde_json::from_value(p)?, out.clone(), st),
        "pty.write" => pty::write(st, p["ptyId"].as_u64().unwrap_or(0), p["data"].as_str().unwrap_or("")),
        "pty.resize" => pty::resize(st, p["ptyId"].as_u64().unwrap_or(0), p["cols"].as_u64().unwrap_or(80) as u16, p["rows"].as_u64().unwrap_or(24) as u16),
        "pty.kill" => pty::kill(st, p["ptyId"].as_u64().unwrap_or(0)),
        "git.status" => git::status(serde_json::from_value(p)?).await,
        "git.show" => git::show(serde_json::from_value(p)?).await,
        "git.stage" => git::stage(serde_json::from_value(p)?, true).await,
        "git.unstage" => git::stage(serde_json::from_value(p)?, false).await,
        "git.commit" => git::commit(serde_json::from_value(p)?).await,
        _ => anyhow::bail!("unknown method {method}"),
    }
}
