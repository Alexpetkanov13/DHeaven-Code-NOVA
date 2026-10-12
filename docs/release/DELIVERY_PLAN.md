# DHeaven Code: NOVA — Delivery Plan

> Status: plan only. No phase has been implemented. Estimates are rough and assume one focused engineer + AI assistance.

## Phase overview
| Phase | Name | Depends on | Rough size |
|---|---|---|---|
| 0 | Audit & architecture | — | done (docs) |
| 1 | Runnable shell | 0 | 2–3 wks |
| 2 | Search, terminal, Git, splits | 1 | 3–4 wks |
| 3 | LSP (Java/Kotlin/Gradle → TS/Python/Rust) | 1, 2 (novad) | 4–6 wks |
| 4 | DAP debugging + test explorer | 3 | 4 wks |
| 5 | NOVA AI | 1, 2, trust | 3–4 wks |
| 6 | Extensions | 1, 4 | 4–6 wks |
| 7 | Advanced: Minecraft Fabric/Paper pack, remote, DB, collab | 3, 4, 6 | ongoing |
| 8 | Polish & release | all | 3+ wks |

## Phase 0 — Audit & architecture
Scope: repo audit (result: new repository), ARCHITECTURE.md, ADR 0001–0010, this plan.
Acceptance: docs committed; no code claims.

## Phase 1 — Runnable shell
Scope: Electron app with secure window config; React workbench (activity bar, sidebar, editor area, panel, status bar); folder explorer (open folder, tree, create/rename/delete with confirm); Monaco with tabs, dirty state, save/save-all, conflict detection; recent workspaces; settings (JSON, schema-validated) with UI; command palette with keybindings; bottom panel scaffold (Output/Problems — only real content); NOVA theme + Focus mode; Windows `.ps1` scripts; minimal novad with fs.read/write/list/watch.
Acceptance:
- `pnpm install && pnpm dev` launches the app on Windows and Linux.
- Open a folder, edit a file, save, reopen app → recent shows folder, file content persisted.
- External change to an open file is detected; conflict prompt on save.
- Security test asserts `window.require`, `process` undefined in renderer; CSP header present.
- Unit (vitest), Rust (`cargo test`), and Playwright smoke tests pass in CI.
- `pnpm dist:win` produces unsigned NSIS + portable ZIP (verified on a Windows runner).

### Phase 1 task breakdown
| # | Task | Output | Verify |
|---|---|---|---|
| 1.1 | Monorepo scaffold: pnpm workspace, Cargo workspace, TS strict, ESLint, Prettier, `.editorconfig`, pinned toolchains (`.nvmrc`, `rust-toolchain.toml`) | builds empty | `pnpm -r build`, `cargo build` |
| 1.2 | `apps/desktop` Electron main + preload + Vite React renderer, secure webPreferences, CSP, navigation lock | window opens | Playwright launch test, security assertions |
| 1.3 | `packages/ipc-contract`: envelope, error codes, zod schemas for `app.*`, `fs.*`, `settings.*`, `workspace.*` v1; JSON Schema export | typed API | contract unit tests |
| 1.4 | `crates/novad`: stdio JSON-RPC, fs list/read/write (atomic), notify watcher w/ debounce, path canonicalization, deadlines, cancellation | daemon | cargo tests incl. path-escape tests |
| 1.5 | Main supervisor: spawn/restart novad with backoff; health ping; bridge | resilient link | test: kill novad → auto-recover |
| 1.6 | Workbench layout + NOVA design tokens (Focus/NOVA themes), resizable panes, a11y roles | UI | visual + keyboard nav check |
| 1.7 | Explorer tree (virtualized), file ops with confirm | explorer | E2E: create/rename/delete |
| 1.8 | Monaco integration (local workers), tabs, dirty markers, save/save-all, mtime conflict | editor | E2E: edit/save/reopen |
| 1.9 | Settings store (JSON + schema), settings UI, recent workspaces in SQLite | persistence | E2E across restart |
| 1.10 | Command palette + keybinding registry | commands | E2E: Ctrl+Shift+P runs command |
| 1.11 | Panels (Output log from main/novad, Problems placeholder hidden until real data) | panel | manual + E2E |
| 1.12 | Windows scripts (`scripts/*.ps1`), electron-builder config NSIS + ZIP, CI matrix (windows-latest, ubuntu-latest) | artifacts | CI run logs |
| 1.13 | Startup/keystroke benchmark harness; record first real numbers in `docs/perf/` | perf report | measured values with hardware |

## Phase 2 — Search, terminal, Git, splits
Scope: workspace search/replace via novad (streamed, capped, cancellable, respects .gitignore); xterm.js terminals over PTY (ConPTY on Windows) with process-tree kill; Git status/diff/stage/commit/branch/log via CLI; editor split groups.
Acceptance: search 100k-file fixture streams results without UI jank; closing terminal kills child tree; Git ops match `git` CLI output on fixtures; trust blocks hook-running ops when untrusted.

## Phase 3 — LSP
Scope: LSP manager in novad, Monaco client adapter, server discovery/install guidance, JDK detection; Java (JDT LS), Kotlin, Gradle first; then TypeScript, Python, Rust. Diagnostics, completion, hover, go-to-definition, references, rename, formatting where supported.
Acceptance: fixture projects show real diagnostics; killing/hanging a server shows a status warning and UI stays responsive; untrusted workspace doesn't launch workspace-defined servers.

## Phase 4 — DAP + tests
Scope: DAP client, launch configs, breakpoints, call stack, variables, watch, debug console; Java + Node + Python adapters; test explorer (JUnit/Gradle, vitest/jest, pytest) from real runner output.
Acceptance: debug a fixture program end-to-end on Windows; test results parsed from real runs.

## Phase 5 — NOVA AI
Scope: provider interface, Ollama + one cloud adapter, chat panel, inline suggestions, context preview, diff-approval edits, keychain keys, audit log of requests. Off by default.
Acceptance: with AI off, zero network egress (verified by test); prompt-injection fixture files do not trigger actions; every edit requires approval.

## Phase 6 — Extensions
Scope: extension host utilityProcess, manifest + capability permissions, extension SDK (`packages/extension-api`), sample extensions, local install from folder/VSIX-like archive (own format).
Acceptance: misbehaving sample (infinite loop) is killed without freezing UI; denied capability calls fail with clear errors.

## Phase 7 — Advanced
Minecraft Java pack (Fabric/Paper templates, Gradle run configs, mappings-aware nav), remote dev (SSH via novad), DB explorer, collaboration (CRDT, opt-in). Each gets its own ADR before work starts.

## Phase 8 — Polish & release
Spectra mode effects with frame-budget guard, onboarding, a11y audit (screen readers, contrast), localization scaffolding, code signing, auto-update, docs (privacy, security, third-party notices, troubleshooting), measured performance report, SBOM.

## Top risks & mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Scope far exceeds a single team's capacity | Nothing ships | Strict vertical slices; each phase independently shippable; defer Phase 7 |
| No Windows build/test environment in current sandbox (Linux) | Windows claims unverifiable | CI on `windows-latest`; label artifacts unverified until run there |
| No code-signing cert | SmartScreen warnings | Ship unsigned dev builds clearly labelled; obtain cert before Phase 8 |
| ConPTY / process-tree edge cases on Windows | Orphaned processes, broken terminals | Job Objects; dedicated Windows E2E tests |
| JDT LS / Kotlin LS memory & startup cost | Sluggish Java experience | Lazy start, memory caps, status UI, per-server restart |
| Monaco CSP & bundle weight | Weaker CSP, slower start | Local workers, lazy language loading, document CSP exception |
| Extension sandbox escape | Security breach | Capability API mediation, no raw Node exposure, process limits, review |
| Prompt injection via repo content | Unwanted edits/commands | Approval gates, no auto tool execution, content delimiting |
| Electron security release cadence | Exposure to CVEs | Renovate/Dependabot, monthly Electron bump policy |
| IPC contract drift between TS and Rust | Runtime errors | JSON Schema export + Rust contract tests in CI |
