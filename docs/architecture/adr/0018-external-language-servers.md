# ADR-0018: External (user-installed) language servers: TypeScript/JavaScript, Python, Rust

Status: Accepted

## Context
Phase 3 (ADR-0013) shipped JVM servers (JDT LS, kotlin-ls) that NOVA downloads from a pinned URL with a pinned SHA-256 after consent. The plan also promised TypeScript/JavaScript, Python and Rust. Those ecosystems already have a standard installer the developer trusts and keeps up to date: npm, pip/pipx/uv and rustup. rust-analyzer in particular must match the user's toolchain. Pinning and downloading our own copies would duplicate those package managers, go stale, and (for rust-analyzer) mismatch the toolchain.

## Decision
- **Two server kinds** in `registry.ts`. `jvm` servers are unchanged: pinned download, consent, JDK selection. `external` servers are never downloaded by NOVA:
  - `typescript-language-server --stdio` (TS/JS, incl. `.tsx` → `typescriptreact` and `.jsx` → `javascriptreact`)
  - `pyright-langserver --stdio` (also accepts `basedpyright-langserver`)
  - `rust-analyzer`
- **Discovery.** NOVA uses the path the user picked, if any. Otherwise it searches PATH, then `~/.cargo/bin`, `~/.local/bin` and `%APPDATA%\npm` (or `/usr/local/bin` and `/opt/homebrew/bin`), because a GUI-launched app often has a shorter PATH. On Windows it honours PATHEXT, so the `.cmd` shims npm installs are found.
- **Verification.** Servers that support it are probed with `--version` (10 s bound, exit 0 required). This matters for rust-analyzer: rustup installs a proxy binary even when the component is missing, and that proxy fails. pyright-langserver has no version flag, so it is checked for existence only. The result is cached until Re-detect, Restart or a path change.
- **Missing server = setup guidance.** The card shows the exact install commands (e.g. `npm install -g typescript-language-server typescript`, `pipx install pyright`, `rustup component add rust-analyzer`) and a Re-detect button. The state is `blocked`, no process is spawned, and there is no Install button.
- **Path override without widening the renderer's power.** `settings.lspServerPaths` is excluded from `SettingsPatch`. The only way to set it is `lsp.setPath.v1`, where main shows a native file picker. This follows the same rule as terminal profiles: the renderer never names an executable for main to run.
- **Windows `.cmd` shims.** Node refuses to spawn `.cmd`/`.bat` directly since CVE-2024-27980. NOVA runs them as `cmd.exe /d /s /c ""<shim>" "<arg>""` with `windowsVerbatimArguments`. Paths or arguments containing cmd metacharacters (`" % ^ & | < > !`) are refused, not escaped.
- **Monaco's TypeScript worker.** The bundled worker is single-file; while `tsls` is ready it would duplicate completions/hovers and report false "Cannot find module" errors. Monaco registers the worker's providers once, and `setModeConfiguration` after setup is a no-op (verified in monaco-editor 0.57 `tsMode.js`). So `renderer/lib/tsGate.ts` wraps `monaco.languages.register*Provider` before the TS mode loads. Providers that are instances of the TS mode's `Adapter` class are proxied, and while the gate is closed their `provide*`/`resolve*` methods return nothing. Worker diagnostics are switched off through `setDiagnosticsOptions` (the adapter listens to that and clears its markers). The gate re-opens whenever no TS server is ready (not installed, stopped, crashed), so TS/JS never lose basic intelligence. F2 falls back to the worker's rename when no server offers rename.
- **Work-done progress.** The client now advertises `window.workDoneProgress`. `$/progress` begin/report/end is shown on the server card (e.g. rust-analyzer "Indexing — 45/120"), coalesced to at most ~4 status events/s. The client answers `workspace/{semanticTokens,inlayHint,codeLens,diagnostic}/refresh` with null, because NOVA has no UI for those yet.
- **Trust.** Unchanged: no server starts in Restricted Mode. This matters more for these servers. tsserver loads tsconfig plugins and the project's own `typescript`, and rust-analyzer's `cargo check` runs build scripts and proc macros.

## Consequences
- NOVA stays honest: an absent server shows setup steps, never a fake "ready". Versions shown are what the binary reports.
- Users manage updates with their usual tools; NOVA does not track CVEs for these servers.
- The TS gate depends on Monaco internals: the `Adapter` base class and the `./*.js` subpath export. A Monaco upgrade must re-check `languages/features/typescript/tsMode.js`. The E2E guards this: with tsls ready, Problems must not contain the worker's "Cannot find module" error.
- Python interpreter/venv selection is not implemented. Pyright uses `python` on PATH or `pyrightconfig.json` / `[tool.pyright]`.
- No DAP or test adapters for these languages yet.
