# Development Progress

## Status: Phase 1 + Slice 2 (explorer ops, watcher, novad search/terminal/Git, trust) — verified on Linux; Windows untested

Environment: Linux x64 container, Node 20.19.2, pnpm 10.34.6, Electron 44.7.0, Rust 1.99.0 stable (installed via rustup; system 1.85 was too old for `ignore`).

## Slice 2 verification (2026-10-12)
| Check | Command | Result |
|---|---|---|
| Rust tests | `cargo test --release` | PASS: 7 tests (search incl. .gitignore/cancel/literal escaping/UTF-16 cols, porcelain v2 parsing, git path rejection, real git stage→unstage→commit→show, real PTY `/bin/sh` echo) |
| Typecheck / lint | `pnpm typecheck`, `pnpm lint` | PASS |
| Unit tests | `pnpm test` | PASS: 29 (4 contract + 25 desktop). New: file ops (create/rename/collision/escape/trash/permanent), watcher coalescing + .git ignore, trust store, replace (literal/regex/groups/escape), DaemonClient against the real novad binary (ping, streamed search, kill → auto-restart → ping) |
| Build | `pnpm build` | PASS |
| E2E | `NOVA_E2E_NO_SANDBOX=1 xvfb-run -a pnpm e2e` | PASS: 2 specs. Slice 2 spec: restricted mode blocks terminal (UI + `UNTRUSTED` over IPC); New File, Rename, Delete through the context menu, checked on disk; external edit reloads a clean tab and external file shows in tree; search streams results; replace preview + apply changes disk and editor; trust → real shell prints `NOVA_42` and the workspace cwd; SCM shows change, opens Monaco diff, stage (checked with `git diff --cached`), commit (checked with `git log`) |
| Linux package | `electron-builder --linux AppImage tar.gz` | PASS. novad bundled in `resources/`. Packaged app launched under xvfb and showed `novad: ready` |
| Windows (NSIS/portable, ConPTY, .ps1) | — | NOT RUN: no Windows host. Windows build also needs `cargo build --release` on Windows before `dist:win` |

Screenshots: `/workspace/nova-search.png`, `/workspace/nova-terminal.png`, `/workspace/nova-git.png`, `/workspace/nova-screenshot.png`.

## Phase 1 verification (earlier, still passing)
Phase 1 E2E (open/edit/save/relaunch/recent, security asserts) re-run with Slice 2: PASS.

## Notes / limitations
- E2E runs Chromium with `--no-sandbox` because the container has no SUID chrome-sandbox. Electron's renderer `sandbox: true` setting is still applied.
- A dirty tab whose file changes on disk is flagged (⚠). It isn't merged; saving triggers the conflict prompt.
- Save As only allows targets inside the open workspace.
- Explorer has no drag-and-drop or multi-select yet.
- Watcher, file ops and replace still run in main (ADR-0012). Replace uses JS RegExp while search uses Rust regex, so advanced patterns may differ.
- Replace All writes to disk; open dirty tabs for those files are flagged, not merged.
- Terminal: one session at a time ("New Terminal" restarts it). No tabs or split terminals yet. Shell = $SHELL / COMSPEC.
- Git: status/diff/stage/unstage/commit only. No branches, push/pull, discard, or hunk staging yet. Requires `git` on PATH.
- Trust gates terminal and commit only. Tasks and extensions don't exist yet.
- On a novad crash, the supervisor restarts it and open terminals end (reported as exited).
- CSP allows `'unsafe-inline'` styles because Monaco needs them.
- Installers are unsigned. App icon is generated from SVG by `apps/desktop/scripts/render-icon.cjs`.
- Bundle includes all Monaco languages (large); lazy loading is planned.

## Next slice
Windows CI (build novad + NSIS/portable, run unit + E2E on windows-latest), multiple terminal tabs, Git branch/discard, move watcher to novad `notify`, then Phase 3 LSP (Java/Kotlin/Gradle).
