# Development Progress

## Status: Phases 1–6 (… + Java debugging, JUnit explorer, NOVA AI, extensions platform) — verified on Linux; Windows untested

Environment: Linux x64 container, Node 20.19.2, pnpm 10.34.6, Electron 44.7.0, Rust 1.99.0 stable (installed via rustup; system 1.85 was too old for `ignore`).

## Phase 5 verification — NOVA AI (2026-10-12)
Box provisioning: Ollama 0.40.3 (user-space tarball in `~/opt/ollama`, `ollama serve` on 127.0.0.1:11434). `ollama pull` failed in this sandbox (registry redirect target resolves to a non-public IP), so the model was built locally: `Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF` q4_k_m from Hugging Face (sha256 1d961463…ff32) + a ChatML Modelfile → `qwen2.5-coder:0.5b`. **All AI E2E runs below use this real model**; stub servers are only used in unit tests and are labelled as such.

| Check | Command | Result |
|---|---|---|
| Typecheck / lint / build / cargo | `pnpm typecheck`, `pnpm lint`, `pnpm build`, `cargo test --release` | PASS (cargo: 7) |
| Unit tests | `pnpm -r test` | PASS: contract 4, ai-core 15, extension-api 11, desktop 64 (+1 skipped, DAP real-adapter test) |
| ai-core unit | (above) | redaction (keys, tokens, JWT, bearer, URL passwords, private keys, assignments; ordinary code untouched); exclusion (.env*, keys, credentials, .git/.ssh…, .gitignore, binary, oversized); untrusted wrapping can't be closed/forged from inside, system prompt rule present; code/command extraction; diff hunks (2 separate hunks, any subset applies, insert/delete/identical); Ollama NDJSON + OpenAI SSE adapters against **local stub HTTP servers**, key only in header and masked in log; retry before first token only, idle timeout, cancel |
| Real-model adapter test | `packages/ai-core/src/real-ollama.int.test.ts` (auto-skips without Ollama) | PASS: both the Ollama adapter and the OpenAI-compatible adapter (Ollama's `/v1`) stream a real completion containing "pong"; both list models |
| AiService unit (stub server) | `src/main/ai/ai.test.ts` | PASS 6: off by default; preview excludes `.env`/ignored/binary/traversal, redacts `sk-…`, sent body == preview, audit log == preview, one send per preview; selection from `.env.production` not sent; cancel mid-stream; keys stored as ciphertext and refused for `basic_text` / unavailable encryption; bad base URL rejected |
| AI E2E (real local model) | `pnpm e2e e2e/ai.spec.ts` | PASS (~8 s; 5 consecutive runs): off by default (IPC refuses with `AI_ERROR`) → Enable; label `Ollama (local) · qwen2.5-coder:0.5b · local`; chat with `.env` active + open editors → preview lists `Not sent: .env — sensitive`, payload contains calc.js and not the secret → streamed (>3 token events) answer stored in history; long essay → Cancel after first tokens → `cancelled`, partial text kept; Explain Selection → payload has `<untrusted_data source="selection: calc.js …">` and the injection rule → answer; Inline Edit → 2 hunks (`return a + b;`, `return a * b;`), file unchanged until applied, accept hunk 1 + reject hunk 2 → **disk** has only `return a + b;`; audit log: exactly 4 requests, all to `127.0.0.1:11434/api/chat`, none containing the `.env` value or `API_TOKEN`; Clear AI history → empty. Test uses temperature 0 + seed 7 for determinism (same real model) |
| All E2E | `NOVA_E2E_NO_SANDBOX=1 NOVA_SERVERS_DIR=~/nova-servers pnpm e2e` | PASS: 13/13 (5.4 min) |
| OS keychain on this box | E2E logs `ai.getConfig.v1` | `safeStorage` reports **no encryption available (backend basic_text)** — no libsecret/KWallet in the container — so the app correctly refuses to store keys here. Real keychain storage is therefore **only unit-tested with a fake cipher**, NOT RUN against a real keyring |
| Cloud OpenAI-compatible provider | — | NOT RUN (no key; the same adapter was exercised against Ollama's OpenAI-compatible `/v1`) |
| Windows | — | NOT RUN |

Screenshot: `/workspace/nova-ai.png`.

Bugs found and fixed: pressing Enter in the Command Palette leaked a newline into the editor after the palette closed (with a selection this replaced the whole file) — affected every palette command; history was written after the done event so the panel missed the last turn.

### Phase 5 limitations
- Tiny model quality is poor (e.g. its "explain" answer misdescribes `mul`); E2E checks plumbing, not answer quality.
- Redaction and sensitive-file rules are pattern-based; they reduce risk, they cannot catch every secret. The preview is the final check.
- Prompt-injection wrapping is a mitigation; the guarantee is structural (no tools, diffs need approval, commands need click + confirm + trust).
- Not covered by E2E: Explain Error from Problems, Generate Tests, Document Function, proposed-command *Run in terminal…*, terminal-output attachment, retries/timeouts against a live server (unit-tested only), provider settings UI (list models / API key fields), history across relaunch.
- Chat only: no inline (ghost-text) completions, no embeddings/codebase search, no multi-file edits.
- Inline edit works on whole lines of an open editor; refuses if the text changed since the request.

## Phase 6 verification — extensions platform (2026-10-12)

| Check | Command | Result |
|---|---|---|
| Typecheck / lint / build / cargo | `pnpm typecheck`, `pnpm lint`, `pnpm build`, `cargo test --release` | PASS (cargo: 7) |
| Unit tests | `pnpm -r test` | PASS: contract 4, extension-api 11, desktop 58 (+1 skipped, the real-adapter DAP test that needs `NOVA_SERVERS_DIR`) |
| extension-api unit | (part of the above) | manifest schema + cross-references, engine ranges, permissions/`checkCapability`, zip-slip names (`..`, absolute, drive, backslash, NUL, reserved, trailing dot), case-insensitive duplicates, size limits, integrity tamper/extra/missing; CLI validate + pack for all 3 examples, bad manifest → exit 1 with messages |
| Host/service/store integration (real host process) | `npx vitest run src/main/ext` | PASS 8 (~7 s): activation + command + output + status + message + tree + timings; Restricted Mode blocks code; permission prompt grant/deny/undeclared; `require('fs')` blocked; hang → host killed, culprit quarantined, host restarts, others keep working; activate throw isolated; install with sidecar, update, rollback, disable persisted, tampered sidecar refused, uninstall; engine mismatch rejected with nothing written. Run 6× in a row after fixing an unhandled `ERR_IPC_CHANNEL_CLOSED` (send after host exit) |
| Theme sanitiser | `src/renderer/lib/themeSanitize.test.ts` | PASS: only hex colours, allowlisted CSS vars and token names survive |
| Extensions E2E | `pnpm e2e e2e/extensions.spec.ts` | PASS 3/3 (~12 s; passed 5 consecutive full runs after the race fixes below). (1) install hello-world `.novaext` (packed by `nova-ext`, sidecar) via confirm dialog showing SHA-256 → Active (onStartupFinished, timing shown); palette *Hello World: Say Hello* → output channel "Hello World" shows `Hello, NOVA! (said 1 time)`, status item `👋 Hello ×1`, toast; clicking the status item runs it again; install custom-theme + sample-language from folders; `demo.nvs` opens as `novascript`, Monarch tokenises `fn` as a keyword; *Color Theme: NOVA Sunset* → `--nova-cyan` = `#FF9E64`, Monaco background `rgb(30,16,32)`, keyword colour changes to the theme's; `beyond` snippet offered; choice persisted to settings. (2) bad-crash `bad.hang` (3 s timeout in test) → quarantined, host pid changes, hello-world still works, editor still editable, quarantined command refused with `EXT_ERROR`. (3) net-peeker: prompt → Deny → `DENIED: Permission 'workspace.read' was denied by the user`; undeclared `network` denied without a prompt; session deny holds without re-prompting; reset to Ask → prompt → Allow + Remember → README read; set to Deny in the view → denied without prompt |
| All E2E | `NOVA_E2E_NO_SANDBOX=1 NOVA_SERVERS_DIR=~/nova-servers pnpm e2e` | PASS: 12/12 (5.3 min) |
| CLI by hand | `nova-ext validate extensions/examples/hello-world`, `pack …/custom-theme`, `validate x.novaext` | OK (sha256 printed and matched) |
| Packaged app (asar unpack of the host) | — | NOT RUN |
| Windows | — | NOT RUN |

Screenshot: `/workspace/nova-extensions.png`.

Bugs found by the E2E and fixed: renderer refresh snapshots overwrote newer status/output events (stale status bar / output); post-crash restart timer and a user command started the host twice and raced activation (now one shared start promise and one in-flight activation per extension).

### Phase 6 limitations
- **Host is not `utilityProcess`** (it ignores `--permission`); it is the Electron binary in Node mode with Node's permission model. See ADR-0015.
- **Network is restricted only at the API level.** Node's permission model cannot block sockets, and the `vm` sandbox is not a security boundary: code that escapes it could open network connections (but still can't write files, read outside the extensions dir, or spawn processes).
- One shared host: a hang in one extension restarts the host for all of them.
- Not covered by E2E (implemented, unit-tested at service/store level or not at all): tree views (service test only), editor context-menu entries, tasks in the palette, editing extension settings, Enable/Disable/Uninstall/Rollback buttons (store/service level only), *Restart host*, `onLanguage`/`onView` activation from the UI, prompt timeout, `workspace.write`/`net.fetch`/`process.exec` happy paths.
- No marketplace (by design), no publisher signatures, no TextMate grammars, no webviews, no extension-provided LSP/debuggers, no keybinding contributions, `when` clauses limited to `never` and `editorLangId == x`.
- M2/M3 commits: `service.ts` (M2) type-imports `store.ts` (M3), and the M3 integration tests use the examples committed in M5, so individual intermediate commits don't type-check/test standalone.

## Phase 4 verification (2026-10-12)
Box provisioning: microsoft/java-debug 0.53.1 plugin jar in `~/nova-servers/java-debug/0.53.1` (SHA-256 4f4778d4…9e24, the pin the in-app installer checks; Maven Central's SHA-1 matched). JUnit 5.11.4 resolved by Gradle from Maven Central.

| Check | Command | Result |
|---|---|---|
| Typecheck / lint / build / cargo | `pnpm typecheck`, `pnpm lint`, `pnpm build`, `cargo test --release` | PASS (cargo: 7) |
| Unit tests | `pnpm -r test` | PASS: contract 4, desktop 49 (+1 skipped = real-adapter integration test, needs `NOVA_SERVERS_DIR`). New: DebugManager vs in-process fake adapter (handshake order, capability-filtered conditional/logpoint breakpoints, command allowlist, adapter error propagation, stale session ids, adapter crash → clean `terminated` and a new session can start, untrusted refusal); JUnit source scan, XML parsing (pass/fail/skip/error, durations, entities/CDATA, class-level stdout fallback), gradle test args, debug-port detection; installer SHA-256 accept/reject for jar |
| Real adapter integration | `NOVA_SERVERS_DIR=~/nova-servers npx vitest run src/main/dap/dap.int.test.ts` | PASS (~10 s): real JDT LS + java-debug: breakpoint at Greeter.java:13 hit, `name` = "NOVA", evaluate `prefix + "!"`, step (reason `step`), continue → program output `Hello, NOVA!` |
| Debug E2E | `pnpm e2e e2e/debug.spec.ts` | PASS (~45 s): F9 breakpoint in the gutter, launch config (main class + preLaunch `classes`) saved and started; stops at breakpoint, editor current-line highlight from the adapter's frame, call stack top `greet`, Variables shows `name: "NOVA"`, watch `prefix + "!"` → `"Hello!"`, Debug Console evaluates `name.length()` → 4, Step Over, Step Out into `main`, Continue → terminated, console shows `Hello, NOVA!` and exit code 0 |
| Tests E2E | `pnpm e2e e2e/tests.spec.ts` | PASS (3 tests): with `NOVA_DEMO_FAIL=1` Run All → 3 passed / 1 failed / 1 skipped / 0 errors (from Gradle's JUnit XML), failure message + stack (`GreeterTest.java:29`), captured stdout; Rerun Failed runs only `--tests …deliberateFailure`; single method run → exit 0. Without the env var: 3 passed / 2 skipped, exit 0. Debug single test: `--debug-jvm` → auto attach → stops at breakpoint in MathTest, `sum` = 5, continue → test passes |
| All E2E | `pnpm e2e` | PASS: 9/9 (4.3 min) |
| In-app java-debug download | — | NOT RUN against the network (pre-provisioned, per brief); consent dialog + SHA-256 path unit-tested with an injected fetch |
| Windows | — | NOT RUN |

Screenshots: `/workspace/nova-debug.png`, `/workspace/nova-tests.png`.

### Phase 4 limitations
- One debug session at a time; Java only (DAP layer is generic, no other adapter wired).
- No exception breakpoints UI (NOVA sends an empty filter list), no data breakpoints, no hover-evaluate, no set-variable UI, no hot code replace.
- Breakpoint lines don't move when you edit lines above them (stored by line number).
- Debug crash isolation verified at unit level (fake adapter disconnect) — not by killing JDT LS during an E2E session.
- Launch resolution depends on JDT LS having imported the Gradle project (first session can wait up to ~4 min on a cold import).
- Test discovery is a source scan: inherited, `@Nested`, `@TestFactory`/dynamic tests and Kotlin edge cases aren't listed (Gradle still runs them; their results appear only in counts). Gradle's default XML puts stdout per class, shown as "class-level output".
- Test runs require Gradle (no Maven); `--rerun` needs Gradle ≥ 7.6.
- M1 commit already contains the Java adapter and test-explorer sources because App/main import them; M2/M3 commits add their tests/E2E and fixes.

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
- Trust gates terminal, commit, language servers, Gradle runs, debugging, test runs and extension code.
- On a novad crash, the supervisor restarts it and open terminals end (reported as exited).
- CSP allows `'unsafe-inline'` styles because Monaco needs them.
- Installers are unsigned. App icon is generated from SVG by `apps/desktop/scripts/render-icon.cjs`.
- Bundle includes all Monaco languages (large); lazy loading is planned.

## Next slice
AI: inline completions, codebase retrieval with the same exclusion rules, multi-file edit proposals, E2E for the remaining AI actions and a real keyring (Windows/macOS CI). Extensions: publisher signing for `.novaext`, per-extension hosts or an OS-level sandbox (seccomp / AppContainer) to make network restriction real, keybinding + richer `when` contributions, webview-free custom editors, extension-provided language servers; plus the Phase 4 items: Windows CI (build novad + NSIS/portable; unit + E2E incl. JDT LS/java-debug/Gradle on windows-latest), exception breakpoints + hover evaluate + hot code replace, breakpoint line tracking on edits, JDT-based test discovery (`vscode.java.test` / nested + dynamic tests), Maven support, server-initiated applyEdit, jdt:// class-file viewer, multiple terminal tabs, Git branch/discard.
