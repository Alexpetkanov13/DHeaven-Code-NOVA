# ADR-0013: Phase 3 — LSP client and Gradle runner live in Electron main; servers pinned + consent-installed

Status: Accepted (Phase 3)

## Context
ADR-0005 planned LSP/DAP clients and ADR-0003 a Rust daemon (novad). Phase 3 needed a working Java/Kotlin story quickly while keeping the renderer sandboxed and the IPC contract (ADR-0004) as the only boundary.

## Decision
- **LSP in main (TypeScript).** `LspConnection` (Content-Length JSON-RPC over stdio) and `LspManager` (one supervised process per workspace × server) run in Electron main. Renderer talks only through allowlisted `lsp.*.v1` channels; requests are limited to `LSP_METHODS`. Servers are started only for trusted workspaces (ADR-0008) and stopped when trust is revoked.
- **Supervision.** Crash → restart with backoff 500·2^(n−1) ms, give up after 3 crashes in 60 s (state `failed`, manual Restart). Servers are spawned in their own process group and killed as a tree. The renderer re-sends `didOpen` for open models whenever a server becomes ready.
- **URIs/positions.** URIs are canonicalized (Monaco style: lowercase drive, `%3A`) at the boundary; positions stay UTF-16 (LSP default, also Monaco's).
- **Honest capability badges** come only from the server's `initialize` result plus `client/registerCapability`.
- **Server pinning + consent.** Each server has a pinned version, URL and SHA-256 in `registry.ts`. Nothing is downloaded until the user confirms a dialog naming URL, size and license; the archive is hash-verified before extraction. `NOVA_SERVERS_DIR` pre-provisions servers (tests/offline).
- **JDK selection.** Discovery (JAVA_HOME, PATH, common dirs, `release` file) with global + per-workspace override; each server declares `minJava`/`maxJava` (kotlin-ls is capped at 21 because its embedded compiler crashes parsing `25.0.4.1`).
- **Gradle in main too.** `gradle.ts` runs the wrapper (`gradlew` / `cmd /c gradlew.bat`) with `--console=plain`, streams output as events, reports exit code/signal, kills the process tree, and parses javac/kotlinc diagnostics into Problems. Trust-gated because it executes build scripts.

## Consequences
- Fast to ship and test with real servers; no extra Rust protocol surface.
- Main process carries more work; a misbehaving server can't freeze the renderer, but heavy JSON traffic is parsed in main. Moving LSP transport to novad remains an option (contract unchanged).
- Killing a Gradle run kills the wrapper client tree; a long-lived Gradle *daemon* is a separate process that Gradle itself is expected to cancel when the client disconnects — NOVA does not kill shared daemons.
- Windows paths (cmd.exe wrappers, taskkill /T) are implemented but untested.
