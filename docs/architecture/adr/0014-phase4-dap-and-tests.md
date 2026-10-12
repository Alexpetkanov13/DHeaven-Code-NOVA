# ADR-0014: Phase 4 — DAP client in main, java-debug as a JDT LS bundle, Gradle-driven JUnit

Status: Accepted (Phase 4)

## Decision
- **Generic DAP client in Electron main** (`dap/connection.ts`, `dap/manager.ts`): Content-Length framing (shared with LSP), request timeouts, stale-response drop, reverse requests refused (`runInTerminal` unsupported → adapter uses its internal console). One session at a time. Start is trust-gated and cancellable (abort kills a running preLaunch Gradle task; Stop sends `disconnect{terminateDebuggee}` and closes the socket). An adapter disconnect ends the session (`terminated`) without affecting the editor.
- **Renderer owns only UI state**; breakpoints are persisted per workspace in userData by main and pushed to the adapter on `initialized` and on change. Conditional breakpoints / logpoints / hit counts are only sent if the adapter's `initialize` capabilities say it supports them. Current line, threads, frames and variables come only from adapter events/responses.
- Only allowlisted DAP commands can be forwarded from the renderer (`DAP_COMMANDS`).
- **Java adapter**: microsoft/java-debug 0.53.1 plugin jar (Maven Central, SHA-256 pinned; Maven's published SHA-1 also matched when provisioned) is passed to JDT LS via `initializationOptions.bundles`. NOVA resolves `vscode.java.resolveMainClass` / `resolveClasspath` and starts a session with `vscode.java.startDebugSession` (returns a TCP port). Install only after a consent dialog; JDT LS restarts to load it.
- **JUnit**: discovery by source scan (fast, no build); runs via `gradle test --tests … --rerun`; results only from the JUnit XML Gradle writes (old results deleted before each run). Debugging a test uses `--debug-jvm` and an attach session once Gradle prints the listening port.

## Consequences
- Debugging Java requires a working JDT LS import of the project; first session waits for import (bounded retries).
- Source-scan discovery misses inherited, `@Nested`, dynamic and `@TestFactory` tests; results still show whatever Gradle ran.
- Windows paths implemented but untested.
