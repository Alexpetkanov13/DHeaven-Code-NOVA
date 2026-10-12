use crate::{rpc::Out, State};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks::UTF8, BinaryDetection, SearcherBuilder};
use grep_matcher::Matcher;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Registry { next: AtomicU64, active: Mutex<HashMap<u64, Arc<AtomicBool>>> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub root: String,
    pub query: String,
    #[serde(default)] pub is_regex: bool,
    #[serde(default)] pub case_sensitive: bool,
    #[serde(default = "default_max")] pub max_results: usize,
}
fn default_max() -> usize { 5000 }

pub fn start(p: Params, out: Out, st: &Arc<State>) -> anyhow::Result<Value> {
    anyhow::ensure!(!p.query.is_empty(), "empty query");
    let id = st.searches.next.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    st.searches.active.lock().unwrap().insert(id, cancel.clone());
    let st2 = st.clone();
    tokio::task::spawn_blocking(move || {
        let r = run(&p, &cancel, |batch| out.notify("search.matches", json!({"searchId": id, "matches": batch})));
        let (total, truncated) = r.unwrap_or((0, false));
        out.notify("search.done", json!({"searchId": id, "total": total, "truncated": truncated, "cancelled": cancel.load(Ordering::SeqCst)}));
        st2.searches.active.lock().unwrap().remove(&id);
    });
    Ok(json!({"searchId": id}))
}

pub fn cancel(st: &State, id: u64) {
    if let Some(c) = st.searches.active.lock().unwrap().get(&id) { c.store(true, Ordering::SeqCst); }
}

/// Walks the tree honoring .gitignore/.ignore, streams matches in batches of 100. Returns (total, truncated).
pub fn run(p: &Params, cancel: &AtomicBool, mut emit: impl FnMut(Vec<Value>)) -> anyhow::Result<(usize, bool)> {
    let pattern = if p.is_regex { p.query.clone() } else { regex_escape(&p.query) };
    let matcher = RegexMatcherBuilder::new().case_insensitive(!p.case_sensitive).build(&pattern)?;
    let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(b'\x00')).line_number(true).build();
    let root = Path::new(&p.root);
    let mut batch = Vec::new();
    let mut total = 0usize;
    for entry in ignore::WalkBuilder::new(root).hidden(false).filter_entry(|e| e.file_name() != ".git").build() {
        if cancel.load(Ordering::Relaxed) { break; }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
        if entry.metadata().map(|m| m.len() > 16 * 1024 * 1024).unwrap_or(true) { continue; }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
        let _ = searcher.search_path(&matcher, entry.path(), UTF8(|line_no, line| {
            if total >= p.max_results || cancel.load(Ordering::Relaxed) { return Ok(false); }
            let text = line.trim_end_matches(['\r', '\n']);
            let mut cols = Vec::new();
            let _ = matcher.find_iter(text.as_bytes(), |m| { cols.push((m.start(), m.end())); cols.len() < 50 });
            for (s, e) in cols {
                total += 1;
                let shown: String = text.chars().take(400).collect();
                batch.push(json!({"rel": rel, "line": line_no, "start": utf16_col(text, s), "end": utf16_col(text, e), "text": shown}));
            }
            Ok(true)
        }));
        if batch.len() >= 100 { emit(std::mem::take(&mut batch)); }
        if total >= p.max_results { break; }
    }
    if !batch.is_empty() { emit(batch); }
    Ok((total, total >= p.max_results))
}

/// Monaco/JS columns are UTF-16 based.
fn utf16_col(s: &str, byte: usize) -> usize { s.get(..byte).map(|p| p.encode_utf16().count()).unwrap_or(byte) }

fn regex_escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() { if "\\.+*?()|[]{}^$#&-~ ".contains(c) && c != ' ' { o.push('\\'); } o.push(c); }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_matches_respecting_gitignore_and_cancel() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "hello world\nnope\nHELLO again\n").unwrap();
        std::fs::create_dir(d.path().join("ignored")).unwrap();
        std::fs::write(d.path().join("ignored/b.txt"), "hello").unwrap();
        std::fs::write(d.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap(); // makes .gitignore apply
        let p = Params { root: d.path().to_string_lossy().into(), query: "hello".into(), is_regex: false, case_sensitive: false, max_results: 100 };
        let mut all = vec![];
        let (n, trunc) = run(&p, &AtomicBool::new(false), |b| all.extend(b)).unwrap();
        assert_eq!(n, 2); assert!(!trunc);
        assert!(all.iter().all(|m| m["rel"] == "a.txt"));
        assert_eq!(all[1]["line"], 3);
        let (n, _) = run(&p, &AtomicBool::new(true), |_| {}).unwrap();
        assert_eq!(n, 0);
    }
    #[test]
    fn literal_query_is_escaped() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.ts"), "a.b(c)\naxb(c)\n").unwrap();
        let p = Params { root: d.path().to_string_lossy().into(), query: "a.b(c)".into(), is_regex: false, case_sensitive: true, max_results: 10 };
        assert_eq!(run(&p, &AtomicBool::new(false), |_| {}).unwrap().0, 1);
    }
    #[test]
    fn utf16_columns() { assert_eq!(utf16_col("é😀x", "é😀".len()), 3); }
}
