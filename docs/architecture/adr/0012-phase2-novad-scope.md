# ADR-0012: Phase 2 novad scope and protocol

- Status: Accepted
- Date: 2026-10-12
- Amends: ADR-0003, ADR-0011

## Decision
- `crates/novad` (Rust stable, Tokio) runs search (`ignore` + `grep-searcher`/`grep-regex`, cancellable, streamed in batches of 100, 16 MB per-file cap, result cap), PTY sessions (`portable-pty`, ConPTY on Windows), and Git through the `git` CLI (porcelain v2 `-z`, 30 s timeout, `GIT_TERMINAL_PROMPT=0`, path checks, `--` separators).
- Transport: newline-delimited JSON-RPC over stdio. Main (`src/main/daemon.ts`) supervises it with per-request deadlines and restarts it with exponential backoff, giving up after more than 5 crashes in 60 s. Open terminals are reported as exited on restart.
- Still in main for now: the file watcher (recursive `fs.watch`, coalesced at 150 ms), explorer file ops (validated, trash through `shell.trashItem` with permanent-delete fallback only after a second confirm), and replace-apply (JS RegExp).
- Workspace trust gates terminal spawn and `git commit` (hooks). Search, diff and stage work in Restricted Mode.

## Consequences
- Search uses Rust regex syntax but replace uses JS RegExp. Simple patterns behave the same. Advanced regex features can differ (documented limitation; move replace into novad later).
- Recursive `fs.watch` relies on platform support (Linux needs Node ≥ 20). Very large trees may hit inotify limits. Moving to `notify` in novad is planned.
