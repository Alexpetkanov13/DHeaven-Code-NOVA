# Development Progress

## Status: Phases 1–6 + Minecraft developer pack + TS/Python/Rust language servers + pytest/cargo test runs + Python debugging. CI runs unit + E2E on Linux and Windows.

## Python debugging with debugpy (2026-10-13, ADR-0020)
- **`main/dap/python.ts`: a second DAP adapter** next to java-debug, using the existing generic `DebugManager`.
  - Runs `<python> -m debugpy.adapter` over stdio; its process tree is killed on close.
  - Interpreter as for tests (workspace venv, else PATH). Before starting, a debugpy import probe gives a clear error with the pip command if it's missing.
- **Launch config `type: 'python'`:** program or module, shell-like args, cwd, env, justMyCode; also attach to `debugpy --listen`.
- **UI:**
  - Run and Debug has a Type selector; Java fields and the java-debug banner are hidden for Python, and Start no longer requires java-debug for Python configs.
  - The Testing view's 🐞 on pytest tests runs `-m pytest -q "<node id>"` under debugpy.
  - Call-stack frames fall back to the file name from `source.path`. debugpy sends no `source.name`, which the E2E caught as `greet :6`.
- **CI:** `debugpy==1.8.22`.

| Check | Command | Result |
|---|---|---|
| Typecheck / lint | `pnpm typecheck`, `pnpm lint` | PASS |
| Unit + real-adapter integration | `vitest run` (desktop) | PASS 126 (+3 skipped). `python.test.ts`: arg splitting; a missing debugpy names the interpreter and the pip command; **real debugpy 1.8.22** run 3× in a row: breakpoint → stack `greet:6` → local `name='NOVA'` → evaluate → step (`step`) → live breakpoint removal → continue → output + `exited with code 0`; `-m pytest <node id>` stops inside the test; program+module refused. The first version of the test expected one breakpoint hit; the DAP trace showed `greet()` runs 3 times (correct behaviour) |
| E2E | `xvfb-run -a npx playwright test e2e/debug-python.spec.ts` | PASS 2/2, twice. UI config (Type → Python, Module `app.main`) → stops at a gutter breakpoint; Debug Console shows `Python: python3 (PATH) · debugpy 1.8.22`; call stack `greet greeter.py:6`; Variables `name: 'NOVA'`; console evaluate `'NOVA!'`; Step Out → `main.py`; ✕ removes the breakpoint mid-session; Continue → `> Hello, Rust!`, `exited with code 0`. Testing 🐞 on `test_greets_by_name` → stops in the test → Continue → `1 passed` |
| Regression | `debug.spec`, `tests.spec`, `testing-langs.spec` | PASS (Java debug, JUnit debug-attach unchanged) |

## Testing view: pytest and cargo test (2026-10-13, ADR-0019)
- **Frameworks** (`main/testing/`): `gradle` (unchanged), `pytest`, `cargo`. Nodes and results carry `framework`; ids are the tool's own names (pytest node ids, libtest `module::fn`), so reruns pass them straight back.
- **Discovery is a static source scan** (nothing executes, so it works in Restricted Mode).
  - pytest: `test_*` functions and `Test*` methods in `test_*.py` / `*_test.py`.
  - Rust: `#[test]` / `#[…::test]` functions, with module paths from the file layout plus inline `mod` blocks; comments and strings are skipped.
- **Results from the tools themselves:**
  - pytest `--junitxml` (xunit1, so file and node id map back; `junit_logging=out-err` for captured output; `--color=no`).
  - libtest's stable text output (status lines; `---- X stdout ----` sections with `--show-output`; panic message and stack split out). No per-test durations, so `timeMs: null` instead of a fake 0.
- **`tests.run.v1` takes `targets: [{framework, filters}]`;** `[]` means every detected framework, run one after another as one cancellable run. Filters may not start with `-`; Gradle keeps its strict alphabet.
- **Python interpreter:** workspace `.venv`/`venv`/`env`, else `python3` (`python` on Windows). The run output names it. A missing pytest is reported as such.
- **UI:**
  - A framework badge per file.
  - Parametrized results roll up into the function node, and the details pane lists every variant.
  - Cargo groups run their leaves with `--exact`.
  - Debug (🐞) is offered for JUnit only.
- **Fixtures:**
  - `fixtures/python/tests/test_greeter.py`: pass, 2 parametrized, skip, class tests, and a failure gated by `NOVA_DEMO_FAIL=1`.
  - `fixtures/rust-cargo` `greeter::tests`: pass with stdout, ignored with reason, and a failure gated by the same variable.
- **Cleanup:** `fixtures/python/app/__pycache__/*.pyc` had been committed by accident in `363b41e`; removed, and `__pycache__/` / `.pytest_cache/` are now ignored.
- **CI:** `actions/setup-python` 3.12 + `pytest==8.4.2` on both OSes.

| Check | Command | Result |
|---|---|---|
| Typecheck / lint | `tsc`, `eslint src e2e` | PASS |
| Unit | `vitest run` (desktop) | PASS 121 (+3 skipped). New `testing.test.ts` parses **real captured output** (`__data__/pytest.xml` from pytest 8.4.2, `__data__/cargo-output.txt` from rustc 1.97) plus static scans of the fixtures; `testTargets.test.ts` covers filters/minimize/aggregation/running marker |
| E2E | `xvfb-run -a npx playwright test e2e/testing-langs.spec.ts` (pytest 8.4.2, cargo 1.97) | PASS 2/2. **pytest:** discovery; Run All → 4 passed / 1 failed / 1 skipped; params roll up; failure message in details; captured `greeting NOVA`; Rerun Failed passes only that node id; single test → Exit 0. **cargo:** discovery; Run All → 2/1/1, Exit 101; panic message + `panicked at src/greeter.rs:39`; `--show-output` stdout; ignore reason; Rerun Failed → `--exact greeter::tests::deliberate_failure`; single test → Exit 0 |
| Windows | CI | pending (next push) |

## CI round 1 on PR #1 (`363b41e`) and fixes
- **Linux and Windows: 21 passed, 1 skipped (ai), 1 failed.** The failure was the missing-server test. The TS/Python/Rust language tests passed on **both** OSes, including the Windows `.cmd` → `cmd.exe` launch of typescript-language-server.
- **Root cause (product):** npm-installed servers are `#!/usr/bin/env node` shims, and with a reduced PATH (as when a GUI app is launched) node isn't found, so the server crash-loops. Fix `486e793`: external servers start with their own directory first on PATH (npm/nvm/fnm/Volta put node there). Reproduced locally with npm Pyright under `PATH=/usr/bin:/bin`; passes after the fix.
- **Root cause (test, Windows):** setup-node puts npm's `.cmd` shims in `C:\npm\prefix`, away from `node.exe`, and the test had removed node from PATH, which no real session does. Fix `96dca91`: the test keeps node's directory unless it contains the server itself. Verified with npm Pyright first and with the pip wrapper first on PATH.

## External language servers: TypeScript/JavaScript, Python, Rust (2026-10-13, ADR-0018)
Session start audit: existing repo, HEAD `a41d40c`, CI green on ubuntu + windows for that commit. Locally on a fresh container: `cargo build --release`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all PASS (desktop 97 + 2 skipped). The last three commits before this session (Quick Open / Go to Symbol / breadcrumbs / back-forward `5b2bf6d`, split editors up to 4 groups `61b11e6`, session restore / hot exit `a41d40c`) had E2E specs (`navigation`, `split`, `session`) but no entry here; they are covered by the full-suite run below.

Gap found: Phase 3 promised TS/Python/Rust, but the registry only had JVM servers, and the LSP manager required a JDK for every server.

What was built:
- **Two server kinds** (`main/lsp/registry.ts`). `jvm` (JDT LS, kotlin-ls) is unchanged. `external` servers are installed by the user's toolchain and are **never downloaded by NOVA**: `typescript-language-server --stdio` (ts/js; `.tsx`/`.jsx` sent as `typescriptreact`/`javascriptreact`), `pyright-langserver --stdio` (or basedpyright), and `rust-analyzer`.
- **Discovery** (`main/lsp/discover.ts`). The configured path wins, then PATH, then `~/.cargo/bin`, `~/.local/bin` and `%APPDATA%\npm` (or `/usr/local/bin` and `/opt/homebrew/bin`). PATHEXT is honoured on Windows. A `--version` probe (10 s bound) runs where the server supports it; it catches the rustup `rust-analyzer` proxy when the component is missing. The result is cached until Re-detect, Restart or a path change.
- **Windows `.cmd` shims** run through `cmd.exe /d /s /c` with verbatim quoted args. cmd metacharacters in a path or argument are refused.
- **UI** (Language Servers view). An external card shows the executable and where it came from (PATH or chosen by you), the version it reported, setup commands when missing (no Install button), Re-detect, Choose Executable… (native picker in main) and Use PATH. It also shows live work-done progress.
- **`settings.lspServerPaths`** is excluded from `SettingsPatch`. Only `lsp.setPath.v1` (main-process file dialog) can set it, so a renderer patch can't make NOVA run an arbitrary binary.
- **LSP client.** It advertises `window.workDoneProgress`. `$/progress` begin/report/end appears on the card, coalesced to ≤4 status events/s. `*/refresh` server requests are answered with null. Trigger characters now include `" ' / <`.
- **Monaco TS worker gate** (`renderer/lib/tsGate.ts`). Found during E2E: F12 showed "Definitions (2)". `setModeConfiguration` is a no-op after Monaco's TS mode has set up (it registers providers once). The built-in providers are now wrapped at registration time (`instanceof` the TS mode's `Adapter`) and return nothing while typescript-language-server is ready. Worker diagnostics are switched off via `setDiagnosticsOptions`. Everything turns back on when the server isn't ready. F2 falls back to the worker's rename when no server offers rename (before, F2 on TS/JS always said "not supported").
- Definition/references no longer fail as a whole when a target can't be opened (`Promise.allSettled`). Out-of-workspace targets (lib.d.ts, Rust std) are dropped and logged.
- **Fixtures:** `fixtures/typescript-node`, `fixtures/python`, `fixtures/rust-cargo` (standalone `[workspace]`, so it isn't pulled into the repo's Cargo workspace).
- `scripts/provision-servers.mjs` skips external servers. CI installs pinned versions of the three servers the way a user would (`npm i -g typescript-language-server@6.0.2 typescript@5.9.3 pyright@1.1.414`, `rustup component add rust-analyzer`) on both OSes, so `languages.spec` runs for real, including the Windows `.cmd` path.

Box provisioning for this session (outside the repo): typescript-language-server 6.0.2 + typescript 5.9 in `~/opt/tsls` (npm), Pyright 1.1.414 (`~/.local/bin`, pre-installed), rust-analyzer 1.97.0 (`rustup component add`), JDT LS / kotlin-ls / java-debug via `provision-servers.mjs` (SHA-256 verified), OpenJDK 21.0.12.

| Check | Command | Result |
|---|---|---|
| Typecheck / lint / build | `pnpm typecheck`, `pnpm lint`, `pnpm build` | PASS |
| Unit tests | `pnpm test` | PASS: contract 4, ai-core 12 (+3 skipped, no Ollama), extension-api 12, desktop 104 (+3 skipped). One run inside a parallel `pnpm -r` while E2E was running timed out (5 s vitest default) in the new manager test; spawn-heavy tests now have a 30 s budget, and repeated runs pass |
| New unit tests | `discover.test.ts`, `lsp.test.ts`, `session.test.ts` | PATH vs extra dirs, non-executable skipped, first name wins; probe success / non-zero exit with stderr / hang timeout, paths with spaces; manager: missing → `blocked` with setup guidance, no pid, `download: null`; broken probe → reason names path + error; configured path wins (PATH not searched), re-detect after fix → ready with probed version, `.tsx` sent as `typescriptreact`; Windows-only `.cmd` quoting/refusal (runs on Windows CI only); progress text begin/report/end; renderer settings patch cannot set `lspServerPaths` |
| **Languages E2E (real servers)** | `PATH=…tsls…:~/.local/bin:~/.cargo/bin NOVA_E2E_NO_SANDBOX=1 xvfb-run -a npx playwright test e2e/languages.spec.ts` | PASS 4/4. **TS:** tsls ready "found on PATH"; `greet(42)` in main.ts → Problems *Argument of type 'number' is not assignable to parameter of type 'string'* (cross-file, from the server); Problems has no *Cannot find module* (worker off); completion `greetAll`; F12 on `Greeter` → greeter.ts (single result). **Python:** Pyright → *cannot be assigned to parameter "name"*, completion `greet_all`, F12 → app/greeter.py. **Rust:** ready, waits for indexing progress to clear, F12 → src/greeter.rs, completion `greet_all`, `let broken: i32 = "oops"` + save → *mismatched types* (rustc via cargo check). **Missing server:** PATH=/usr/bin:/bin, HOME empty → pyright `blocked`, *Not found on PATH*, setup shows `pipx install pyright`, no Install button, no pid, editor still editable; Choose Executable… → "chosen by you" → Start → ready; `settings.json` has the path; Use PATH → not found again |
| All E2E | `NOVA_SERVERS_DIR=~/nova-servers … xvfb-run -a npx playwright test` | PASS: 22 passed, 1 skipped (ai, no Ollama), 7.8 min, all servers on PATH (so TS fixtures in the older specs also ran with tsls active) |
| Windows | CI on PR #1 | See "CI round 1" above: everything but the missing-server test passed on the first run; fixed in `486e793` / `96dca91` |

Screenshots: `nova-typescript.png`, `nova-rust.png`, `nova-python.png`, `nova-lsp-setup.png` (session scratchpad, not committed).

### Limitations
- No Python interpreter/venv picker (Pyright uses PATH python or its own config); Pyright has no formatter.
- No DAP for TS/JS or Rust (Python: debugpy since ADR-0020; tests: pytest and cargo test since ADR-0019; no JS runners).
- Go to definition into non-workspace files (lib.d.ts, Rust std, JDK) is not browsable.
- Semantic tokens, inlay hints, code lens and pull diagnostics aren't rendered (refresh requests are acknowledged and ignored).
- The TS gate relies on Monaco internals (`tsMode.js` `Adapter` export); re-check on Monaco upgrades. The E2E's "no *Cannot find module*" assertion guards it.
- Ctrl+S is a native menu accelerator, so E2E saves through the command palette (synthetic keys don't reach menu accelerators); real keyboard input is unaffected.

### Next slice (by dependency/value)
1. ~~Test explorer for `cargo test` and pytest~~ (done, ADR-0019). Still open: vitest/jest/node:test, and DAP for js-debug (Node) and CodeLLDB (Rust). Python debugging is done (ADR-0020). The DAP layer is already generic (ADR-0014).
2. Python interpreter/venv picker (discover `.venv`, `venv`, conda, PATH), passed to Pyright via `workspace/configuration` (`python.pythonPath`) and to run/test/debug.
3. Semantic tokens and inlay hints from LSP (servers already advertise them; the refresh requests are wired).
4. Read-only virtual documents for out-of-workspace definitions (lib.d.ts, Rust std, `jdt://` class files).

Environment: Linux x64 container, Node 20.19.2, pnpm 10.34.6, Electron 44.7.0, Rust 1.99.0 stable (installed via rustup; system 1.85 was too old for `ignore`).

## Minecraft developer pack verification (2026-10-12)
Bundled first-party, **declarative** extension `extensions/bundled/minecraft-dev` (`dheaven.minecraft-dev`, installed at startup through the normal validation/integrity path, can be disabled, not uninstallable) + core support: reusable New Project wizard/template engine/version resolvers, `jsonValidation` / `yamlValidation` / `gradleRunTasks` / `projectTemplates` contribution points, Minecraft view, EULA gate. ADR-0017. Commits: M1 `42e6f59`, M2 `cfa3607`, M3 `20688c0`, M4 (this commit).

| Check | Command | Result |
|---|---|---|
| Typecheck / lint / build | `pnpm -r typecheck`, `eslint src e2e`, `pnpm build` | PASS |
| Unit tests | `pnpm -r test` | PASS: contract 4, ai-core 15, extension-api 12, desktop 79 (+2 skipped: DAP real-adapter, LIVE Minecraft build) |
| Template/resolver unit | `src/main/templates/templates.test.ts` | PASS 8: option validation, unknown `{{var}}` fails, non-empty target + `__var__` path traversal refused; Fabric resolver (stable 26.1+ only, matching Fabric API build, Java from Mojang metadata), Paper resolver (releases ≥1.20.6, newest `-stable` build, Java min from Fill) against **stubbed** endpoints; offline → `offline-fallback` with "pinned on 2026-10-12" label; generation renders wrapper (+x), versions, rejects un-resolved MC versions |
| **Live generation + `./gradlew build`** | `NOVA_MC_BUILD=1 JAVA_HOME=<JDK25> vitest run src/main/templates` | PASS (22 s): live official APIs (Fabric meta/maven, fabric-example-mod, Mojang metadata; PaperMC Fill/maven, Gradle Plugin Portal) resolved MC 26.3 / loader 0.19.5 / Loom 1.18-SNAPSHOT / Fabric API 0.162.0+26.3 and Paper API 26.3.build.177-stable / run-paper 3.1.0 / Java 25; both projects built (`livemod-1.0.0.jar`, `liveplugin-1.0.0.jar`) |
| Fabric Loom heaviness | `./gradlew build --no-daemon` with an **empty** `GRADLE_USER_HOME` | BUILD SUCCESSFUL in 40 s, 567 MB downloaded (Gradle 9.7.1 distribution + Minecraft 26.3 jars/libraries). Lighter than expected because 26.x is unobfuscated (no mappings/remapping). Warm-cache builds: Fabric 20 s, Paper 22 s |
| Bundled install unit | `src/main/ext/bundled.test.ts` | PASS: installed once, idempotent (same SHA → no reinstall), disabled state kept, user-installed copy with same id untouched |
| Schema unit | `src/renderer/lib/schemas.test.ts` | PASS 4: template `fabric.mod.json` / `plugin.yml` valid; bad id/schemaVersion/environment/entrypoint/unknown key, missing `main`, bad `load`, `org.bukkit.*` main, pack.mcmeta (pack_format and min/max_format), model elements/face texture refs reported; fileMatch globs |
| Run-task/EULA unit | `src/main/runTasks.test.ts` | PASS 2: plugin ids in Groovy/Kotlin DSL + legacy `apply plugin`, comments ignored; EULA status; gate blocks `runServer`/`:runServer` until `eula=true`; `eula.txt` path traversal refused |
| Manifest unit | extension-api | PASS: new contribution points validate; `../` paths, unknown resolver, traversal globs, bad task names rejected |
| Minecraft E2E | `pnpm e2e e2e/minecraft.spec.ts` | PASS (~7 s; 4 consecutive standalone runs + full suite + server runs after the settle fix noted below): welcome → *New Project…* → Fabric (live versions shown, JDK list filtered to Java 25+) → created; Paper → created; files on disk incl. wrapper; Fabric workspace: Minecraft view lists `runClient` + `runServer` (EULA required); `fabric.mod.json` id → `"Invalid Id!"` gives an error squiggle + marker *String does not match the pattern…*; `hello.sk` opens as `skript` with ≥4 distinct token classes (comment/keyword/event/string/expression); Enter after a `:` line indents; Paper workspace: `plugin.yml` clean, then removing `main` + `load: LATER` → markers *Missing required property "main"*, *Must be one of: "STARTUP", "POSTWORLD"*; Minecraft view lists Paper `runServer`; direct `gradle.run.v1 runServer` refused (*EULA not accepted*); Run → EULA dialog (Accept disabled until checkbox) → Decline → no `eula.txt` |
| **Real Paper `runServer`** | `NOVA_E2E_MC_SERVER=1 pnpm e2e e2e/minecraft.spec.ts` | PASS (24 s warm, ~3.5 min first time incl. Paper download): accept EULA in the dialog → `run/eula.txt` `eula=true` → Paper 26.3 starts (`Done (10.98s)!`), generated plugin logs `[NovaPaper] Nova Paper enabled`; console command `list` answered; **Stop** sends `stop` → `Stopping server` → exit |
| Fabric `runClient` / `runServer` | — | NOT RUN (client needs a display/GPU + Mojang assets download; only listed/detected) |
| All E2E | `NOVA_E2E_NO_SANDBOX=1 NOVA_SERVERS_DIR=~/nova-servers pnpm e2e` | PASS: 14/14 (5.6 min) |
| Windows | — | NOT RUN |

Screenshots: `/workspace/nova-mc-wizard.png` (wizard, live versions), `/workspace/nova-mc-view.png` (Minecraft view with a running Paper server).
Gradle daemons started by these runs were stopped afterwards (none left running).

Bugs found and fixed: Gradle runs had stdin closed, so the Paper console spun on EOF printing `>` prompts until the renderer crashed (stdin now kept open, never written unless you send a console command); Monaco JSON reported schema violations only as warnings (now errors); generated `plugin.yml` with an empty description was itself invalid (now quoted); `indentationRules` in the Skript language configuration silently disabled the `onEnterRules` indent under Monaco's default `advanced` auto-indent (removed; Enter-after-colon indent verified).

### Minecraft pack limitations
- Fabric template supports Minecraft **26.1+ only** (unobfuscated layout); 1.21.x and older (Yarn/Mojmap + remapping) are not offered. Paper template offers releases ≥ 1.20.6.
- Loom version comes from the official fabric-example-mod `gradle.properties` (Fabric publishes no "recommended Loom" API); it is currently a `-SNAPSHOT`.
- Skript support is **syntax only** (Monarch highlighting, snippets, Enter-after-colon indent): no validation against Skript's syntax registry, no addon awareness, no outdent for `else:`.
- YAML validation uses a JSON-Schema subset validator (no `$ref`, `allOf`, formats); no YAML hover; completion is top-level keys only.
- Run tasks are detected statically from plugin ids in the root build script: convention plugins, `buildSrc`, subprojects are missed. Fabric `runServer` shares the EULA gate (`run/`), but was not executed here.
- In the E2E, the Enter-after-colon check needs a 300 ms settle after typing (without it, 2/3 runs failed — most likely the suggest widget racing the keypress); real typing is unaffected as far as observed.
- Schemas were written for NOVA from public docs (no SchemaStore copy); they may lag format changes (e.g. new pack.mcmeta fields).
- No Mojang assets are bundled; Loom/run-paper download Minecraft/Paper under their own terms at build/run time.

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
Minecraft: Fabric template for 1.21.x (mappings), Forge/NeoForge templates, Fabric runClient verification on a desktop, Skript validation via an addon-aware parser, YAML hover. AI: inline completions, codebase retrieval with the same exclusion rules, multi-file edit proposals, E2E for the remaining AI actions and a real keyring (Windows/macOS CI). Extensions: publisher signing for `.novaext`, per-extension hosts or an OS-level sandbox (seccomp / AppContainer) to make network restriction real, keybinding + richer `when` contributions, webview-free custom editors, extension-provided language servers; plus the Phase 4 items: Windows CI (build novad + NSIS/portable; unit + E2E incl. JDT LS/java-debug/Gradle on windows-latest), exception breakpoints + hover evaluate + hot code replace, breakpoint line tracking on edits, JDT-based test discovery (`vscode.java.test` / nested + dynamic tests), Maven support, server-initiated applyEdit, jdt:// class-file viewer, multiple terminal tabs, Git branch/discard.

## CI / Windows (GitHub Actions)

- Repo (private): https://github.com/Alexpetkanov13/DHeaven-Code-NOVA
- `ci.yml`: matrix of ubuntu-latest and windows-latest. Steps: pnpm install, Rust (cargo test), typecheck, lint, unit tests, build, JDK 21 (+25), provisioning of jdtls / kotlin-ls / java-debug (pinned SHA-256, cached in `.nova-servers`), then Playwright Electron E2E (xvfb on Linux, direct on Windows).
- `windows-release.yml`: builds unsigned NSIS setup, portable and zip, writes SHA256SUMS.txt, and `scripts/verify-artifacts.mjs` checks that `dheaven-code-nova.exe` and `resources/novad.exe` are inside the zip. Output is uploaded as the artifact `DHeaven-Code-NOVA-windows-x64-unsigned`. No public release is made.
- Linux E2E is a hard gate: 13 passed. 1 skipped: AI, because no Ollama runs on CI.
- kotlin-ls quality checks are best-effort annotations. On CI it reports "Unresolved reference: println" because the stdlib is not resolved.
- Windows fixes so far:
  - Absolute file URIs in the LSP test.
  - The exec-bit test is skipped on win32.
  - `JAVA_HOME_<N>_X64` JDK discovery.
  - A race in the extension DENIED test.
  - The app's process tree is killed (`taskkill /T /F`) when `app.close()` hangs.
- Windows E2E is **blocking** again (since the commit that follows the Windows fixes below).
  Diagnostic runs (`e2e-windows.yml`, workflow_dispatch with a spec filter):
  - Full run 38373044498: 11 passed, 1 skipped (ai), 2 failed (debug Continue race; java launch fell over because of it).
  - Run 38375265168 after the debug fix: debug + java passed.
  - Earlier runs 38365992898 (slice2 + extensions: 4/4) and 38370952034 (debug, java, tests debug-attach passed).
- Windows fixes:
  - App: terminal default shell is PowerShell (pwsh if on PATH) instead of COMSPEC/cmd.exe; `NOVA_SHELL` override.
  - App: 8 s hard quit deadline so lingering children cannot keep the app alive.
  - App: transient EPERM/EBUSY retries on rename/rm (extension install, atomic writes, explorer delete/rename, LSP installer).
  - App: `vscode.java.resolveMainClass` gets a file URI instead of a raw `C:\` path (was "Illegal character in opaque part").
  - App: `startDebugSession` is retried when JDT LS cancels it during a project build.
  - App: JUnit results older than the run are ignored if a locked result file survives the clear.
  - Test: PowerShell syntax for the terminal command on Windows.
  - Test: every launched app is closed/killed in afterEach; on Windows CI, leftover JVMs (Gradle daemons/debuggees that inherit Electron's stdio handles) are killed after each spec file. This removed the 180 s worker-teardown errors.
  - Test: debug spec re-issues Continue if java-debug drops it while settling after Step Out.
- Remaining Windows gaps:
  - kotlin-ls does not resolve the Kotlin stdlib (upstream; best-effort, annotated).
  - The debug Continue-after-Step-Out race is handled in the test, not in the app.
  - Code signing: none.

## Hardening, terminals, Git (Oct 13)

- **Debug (app):** DebugManager marks the session `running` as soon as the adapter accepts continue/next/stepIn/stepOut, until the next `stopped` event. Execution commands are refused while not paused. This replaces the e2e "re-click Continue" workaround: java-debug sent a step's response before its stop and no `continued` event, so a Continue issued in between was dropped. Unit test: `dap.test.ts` "execution control".
- **Gradle daemons:** NOVA records the projects where it ran Gradle. On quit and on workspace switch it runs `gradlew --stop` (or `gradle --stop`) per project, each bounded to 6 s (killed after). Unit test with a fake wrapper.
- **Terminals:** multiple tabs, each splittable into two panes; per-pane Kill; profile picker.
  - Windows profiles: PowerShell 7 / Windows PowerShell / Command Prompt / Git Bash.
  - Unix profiles: `$SHELL` / bash / zsh / fish / sh.
  - The executable is resolved in main from a profile id, so the renderer cannot pick an arbitrary binary.
  - The choice is persisted as `settings.terminalProfile`.
  - Tests: `terminalProfiles.test.ts`, `e2e/terminals.spec.ts`.
- **Git** (git CLI from main, `src/main/git.ts`):
  - Branch list, create, and switch. A dirty tracked tree asks for confirmation; local or remote-tracking branches are both supported.
  - Discard with confirmation: restore from HEAD, unstage and delete new files, delete untracked files; paths are guarded.
  - fetch --prune / pull --ff-only / push, with `-u origin <branch>` when there is no upstream.
  - Ahead/behind shown in the SCM view and the status bar.
  - Uses the user's own config and credential helper. `GIT_TERMINAL_PROMPT=0` and no askpass, so it never prompts or hangs. All output and errors are redacted (URL userinfo, auth headers, GitHub/GitLab tokens, token query params).
  - Every new channel is trust-gated (hooks and credential helpers execute).
  - Tests: `git.test.ts` (bare remote, two clones, redaction) and `e2e/git.spec.ts` (local bare remote; push, fetch, pull, dirty switch, discard).
- Screenshots: `/workspace/nova-terminals.png`, `/workspace/nova-git-branches.png`.

### Windows reliability, status as of f58715b
- 3× full Windows diagnostic runs on 246e30e (38386728955 / 38386741036 / 38386752833): 14/15, 12/15, 14/15 passed (ai skipped).
  - Failing in all three: tests "debug a single test". startDebugSession timed out; fixed in f756d09 (120 s + retry).
  - debug spec (1 of 3): the Continue race persists on Windows. `stopped` stays after Continue; root cause still open.
  - workbench (1 of 3): firstWindow timeout after a failed debug spec (cascade).
- Re-run 38391144517 (debug + tests only, f756d09): debug failed (Continue race again) and tests "run one" failed (Exit 1, no results). This is an open Windows flake. Run-one output is now printed on failure for diagnosis.
- CI 38391129158 (f756d09): failed.
  - Linux: the terminals spec failed because of reordered keystrokes; fixed in f58715b (writes serialized).
  - Windows: failed on the E2E flakes above.
- **Windows E2E is currently NOT reliably green.** The step stays blocking, so CI is red until the debug Continue race and the tests run-one flake are fixed.

### Windows flakes: root causes (e876d74 / 08a69c6)
- **Tests "run one" (Exit 1, no output).**
  - Root cause, in the app (TestsView): the previous run's `done`/exit code stayed on screen until `tests.run.v1` returned the new run id. Gradle output that arrived before that id was dropped.
  - So "Exit 1" was the *previous* (rerun-failed) run, and the empty output was the new run's dropped early output. Slow IPC on Windows widened the window.
  - Fix: a new run is marked started synchronously, and early output/done are buffered and replayed.
- **Debug Continue / call stack.** A DAP trace (`NOVA_DAP_TRACE=<dir>`, uploaded with the E2E results) showed this was a wrong assumption in the test.
  - greet() is a single statement, so Step Over already returns to App.main. The following Step Out then left main into JDK `Thread.exit`, which happened deterministically on JDK 25 locally.
  - The spec now does Step Out (back to App.main), then Step Over over the println, then Continue.
  - The earlier app fix (no Continue while a step is in flight) stays.
  - The trace also showed java-debug sometimes sends `terminated` without `exited`. The app now logs that the adapter did not report an exit code, instead of omitting the line.
- Windows diagnostic full E2E on e876d74:
  - 38395227462: 15/15 passed (ai skipped).
  - 38395239705: 15/15 passed (ai skipped).
  - 38395215112: 12/15. debug failed (the missing `exited`, handled in 08a69c6). Two `firstWindow` 30 s timeouts in tests.spec, cause not yet known.
- CI 38395026239 (e876d74): ubuntu success, windows success. Release 38395026440: success.

### Windows slow window-open (firstWindow timeouts)
- Root cause (from NOVA_STARTUP_LOG phase timings): `installBundled` ran before `createWindow()` and took 19–84 s on a fresh Windows profile (copy + hash of bundled extensions under Defender scanning). Leftover electron/novad processes were seen but were not the cause.
- Fix (720a56c): window is created first; bundled install runs in the background; `ext.*`, `template.*`, `workspace.*` and `trust.set.v1` IPC wait for it.
- Verified: CI 38402340646 green (ubuntu+windows); 3/3 Windows diagnostic full E2E green (38402352176, 38402365681, 38402378799), 15/15 each.
- Open: `.nova-servers` blobs from 9c390d8 remain in history (untracked in 18f6fb4); purging needs a history rewrite + force-push (awaiting approval).
