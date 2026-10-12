# Development Progress

## Status: Phase 1 + Slice 2 + Phase 3 (LSP client, Java/JDT LS, Kotlin best-effort, Gradle) — verified on Linux; Windows untested

Environment: Linux x64 container, Node 20.19.2, pnpm 10.34.6, Electron 44.7.0, Rust 1.99.0 stable (installed via rustup; system 1.85 was too old for `ignore`).

## Phase 3 verification (2026-10-12)
Box provisioning (outside the repo): Temurin JDK 21.0.12 in `~/.jdks`, JDT LS 1.61.0 and fwcd kotlin-language-server 1.3.13 pre-provisioned in `~/nova-servers` (`NOVA_SERVERS_DIR`; same pinned SHA-256 the in-app installer checks), Gradle 9.7.1 via the fixtures' wrapper. A JDK 25.0.4.1 is also on the box.

| Check | Command | Result |
|---|---|---|
| Rust tests | `cargo test --release` | PASS: 7 (unchanged) |
| Typecheck / lint / build | `pnpm typecheck`, `pnpm lint`, `pnpm build` | PASS |
| Unit tests | `pnpm test` | PASS: desktop 40 + contract. New: JSON-RPC framing (split/multi frames, UTF-8), URI canonicalisation, LspConnection + LspManager vs a fake stdio server (init, responses, cancellation, crash survival; trust gating, doc sync, diagnostics routing, restart after crash; static+dynamic capability badges). Crash-loop → `failed` has no unit test but was observed for real (kotlin-ls on JDK 25, before the fix), text edits/UTF-16 offsets, JDK probing/discovery, Gradle task + javac/kotlinc problem parsing (incl. dedupe of Gradle's repeated compiler output) |
| Java E2E (real JDT LS) | `NOVA_SERVERS_DIR=~/nova-servers pnpm e2e e2e/java.spec.ts` | PASS (~55 s): select JDK 21 → JDT LS ready, badges from real capabilities; typed `int broken = "oops";` → "Type mismatch" in Problems + squiggle; completion lists `greet`; F12 opens Greeter.java; SIGKILL server → editor stays editable, state restarting → ready with new pid, diagnostics come back, logs show exit |
| Gradle E2E | `pnpm e2e e2e/gradle.spec.ts` | PASS (~36 s): detects build.gradle.kts + wrapper; tasks listed via `gradlew tasks --all`; `build` streams output, `BUILD SUCCESSFUL`, exit code 0; deliberate javac error → `compileJava` exit ≠ 0, 1 `[javac]` problem in Problems at App.java:5; `sleepDemo` killed from the UI → "Killed" |
| Kotlin E2E (best effort) | `pnpm e2e e2e/kotlin.spec.ts` | PASS: kotlin-ls reaches ready on JDK 21 with completion/hover/signatureHelp/definition/references/rename/formatting/codeActions advertised; type-mismatch diagnostic shown; completion lists `greet`. Diagnostic/completion checks are soft assertions by design. Observed false positive: "Unresolved reference: println" (server's bundled Kotlin 2.1.0 vs project Kotlin 2.4.21) |
| Fixtures | `./gradlew run` in fixtures/java-gradle and fixtures/kotlin-gradle | PASS: both print `Hello, NOVA!` |
| Previous E2E (workbench, slice2) | `pnpm e2e` | PASS (slice2 test made robust to a slow trash→permanent-delete fallback; product code unchanged) |
| In-app download/install of servers | — | NOT RUN end-to-end against the network in tests (servers pre-provisioned per the brief). Consent dialog + SHA-256 verify paths are implemented |
| Windows (cmd.exe wrappers, `taskkill /T`, gradlew.bat) | — | NOT RUN: no Windows host |

Screenshots: `/workspace/nova-java.png`, `/workspace/nova-lsp-status.png`, `/workspace/nova-gradle.png`, `/workspace/nova-gradle-fail.png`, `/workspace/nova-kotlin.png`.

### Phase 3 limitations
- LSP and Gradle run in Electron main (ADR-0013), not novad.
- Server-initiated `workspace/applyEdit` answers `applied: false`; code actions relying on it report "not applied". Client-side edits (rename preview, formatting, code-action edits) work.
- `jdt://` (library/JDK source) locations are filtered out of definition/references; no class-file viewer.
- JDT LS always runs on a JDK ≥21 (newest found if the selected one is older); the project JDK selection is passed to JDT as the runtime.
- kotlin-ls: community server, embeds Kotlin 2.1.0, lags Kotlin 2.x (false "Unresolved reference" seen), Gradle classpath import can be slow/partial. Crashes on JDK 25.0.4.1 (`JavaVersion.parse`), so NOVA restricts it to JDK 11–21. JetBrains kotlin-lsp is only distributed as a VS Code .vsix bundle and is not integrated.
- Gradle Kill kills the wrapper/client process tree; a shared Gradle daemon is left running (Gradle is expected to cancel the build when the client disconnects — not independently verified). Task list requires running `gradlew tasks` (can take minutes on a cold cache). One run shown at a time; output capped (512 KB in UI, 8 MB parsed).
- javac problems have column 1 (javac's plain output has no column); kotlinc problems carry line+column.
- No DAP/debugging, no test explorer, no Maven yet.

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
- Trust gates terminal, commit, language servers and Gradle runs. Extensions don't exist yet.
- On a novad crash, the supervisor restarts it and open terminals end (reported as exited).
- CSP allows `'unsafe-inline'` styles because Monaco needs them.
- Installers are unsigned. App icon is generated from SVG by `apps/desktop/scripts/render-icon.cjs`.
- Bundle includes all Monaco languages (large); lazy loading is planned.

## Next slice
Windows CI (build novad + NSIS/portable; unit + E2E incl. JDT LS/Gradle on windows-latest), server-initiated applyEdit with preview, jdt:// class-file viewer, Java debugging via java-debug (DAP), JUnit test explorer from Gradle, Maven support, multiple terminal tabs, Git branch/discard.
