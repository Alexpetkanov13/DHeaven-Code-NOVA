use crate::{rpc::Out, State};
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

struct Session { master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn Child + Send + Sync> }

#[derive(Default)]
pub struct Registry { next: AtomicU64, sessions: Mutex<HashMap<u64, Session>> }

#[derive(Deserialize)]
pub struct Spawn { cwd: String, cols: u16, rows: u16, shell: Option<String> }

fn default_shell() -> String {
    if cfg!(windows) { std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into()) }
    else { std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()) }
}

pub fn spawn(p: Spawn, out: Out, st: &Arc<State>) -> anyhow::Result<Value> {
    let pair = native_pty_system().openpty(PtySize { rows: p.rows.max(2), cols: p.cols.max(2), pixel_width: 0, pixel_height: 0 })?;
    let mut cmd = CommandBuilder::new(p.shell.unwrap_or_else(default_shell));
    cmd.cwd(&p.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "DHeavenCodeNOVA");
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let id = st.ptys.next.fetch_add(1, Ordering::SeqCst) + 1;
    st.ptys.sessions.lock().unwrap().insert(id, Session { master: pair.master, writer, child });
    let st2 = st.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.notify("pty.data", json!({"ptyId": id, "data": base64::engine::general_purpose::STANDARD.encode(&buf[..n])})),
            }
        }
        let code = st2.ptys.sessions.lock().unwrap().remove(&id).and_then(|mut s| s.child.wait().ok()).map(|s| s.exit_code());
        out.notify("pty.exit", json!({"ptyId": id, "code": code}));
    });
    Ok(json!({"ptyId": id}))
}

pub fn write(st: &State, id: u64, data: &str) -> anyhow::Result<Value> {
    let mut g = st.ptys.sessions.lock().unwrap();
    let s = g.get_mut(&id).ok_or_else(|| anyhow::anyhow!("no such pty"))?;
    s.writer.write_all(data.as_bytes())?; s.writer.flush()?;
    Ok(json!(null))
}
pub fn resize(st: &State, id: u64, cols: u16, rows: u16) -> anyhow::Result<Value> {
    let g = st.ptys.sessions.lock().unwrap();
    let s = g.get(&id).ok_or_else(|| anyhow::anyhow!("no such pty"))?;
    s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })?;
    Ok(json!(null))
}
pub fn kill(st: &State, id: u64) -> anyhow::Result<Value> {
    if let Some(s) = st.ptys.sessions.lock().unwrap().get_mut(&id) { let _ = s.child.kill(); }
    Ok(json!(null))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn spawns_real_shell_and_streams_output() {
        let (out, rx) = Out::channel();
        let st = Arc::new(State::default());
        let r = spawn(Spawn { cwd: "/".into(), cols: 80, rows: 24, shell: Some("/bin/sh".into()) }, out, &st).unwrap();
        let id = r["ptyId"].as_u64().unwrap();
        write(&st, id, "echo NOVA_$((40+2))\nexit\n").unwrap();
        let mut text = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            let Ok(m) = rx.recv_timeout(std::time::Duration::from_secs(1)) else { continue };
            if m["method"] == "pty.data" { text += &String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(m["params"]["data"].as_str().unwrap()).unwrap()); }
            if m["method"] == "pty.exit" { break; }
        }
        assert!(text.contains("NOVA_42"), "{text}");
    }
}
