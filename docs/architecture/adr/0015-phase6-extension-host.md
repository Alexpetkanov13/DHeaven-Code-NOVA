# ADR-0015: Phase 6 — Extension platform: Node-mode child process host, capability RPC, local packages

Status: Accepted (Phase 6)

## Decision
- **API package** `@nova/extension-api` (versioned, `API_VERSION 1.0.0`, `manifestVersion 1`): manifest schema (zod, strict) + cross-reference validation, permission map + `checkCapability`, `.novaext` reader/packer, host↔main protocol types, and the `nova-ext` CLI (`validate`, `pack`). The same validation code runs in the CLI and in NOVA.
- **Extension host = Electron binary in Node mode**, forked by main (`child_process.fork`, `ELECTRON_RUN_AS_NODE=1`, empty env, `--permission` with read access only to the host script and the extensions directory, 512 MB heap). The brief asked for `utilityProcess`; a probe showed `utilityProcess.fork` **ignores `--permission`** (fs write, `/etc` read and `child_process` all succeeded), so it was rejected. Inside the host, extension modules run in a `vm` context with an allowlisted `require` and no `process`.
- **All side effects go through main** via RPC; main checks the manifest's declared permissions and the user's grants (undeclared → deny; undecided → prompt in the renderer, default deny on timeout). Workspace trust gates code activation; declarative contributions are data and apply in Restricted Mode.
- **Failure handling**: per-request timeouts; a timeout kills the host tree and quarantines the extension whose request was in flight (persisted); restart with backoff; >3 crashes/60 s → failed until manual restart. Activation exceptions are per-extension.
- **Lifecycle store** in userData: staged install + rename, previous version kept for rollback, SHA-256 integrity per file and optional `.sha256` sidecar for the archive, zip-slip/size/duplicate checks, symlinks refused for folder installs, atomic `state.json`.
- **Renderer** only renders contributions it receives from main; theme JSON is sanitised (hex only, allowlisted CSS variables), grammars are Monarch JSON.

## Consequences
- Network is restricted only at the API level (Node's permission model has no network control); `vm` is not a security boundary. Documented in `docs/extension-development/security.md`.
- No marketplace, no publisher signatures, no TextMate grammars, no webviews, no LSP-from-extension.
- One shared host for all extensions: a hang in one restarts the host for all (they are re-activated lazily / by `onStartupFinished`).
- Packaged builds need `dist/main/extension-host.cjs` unpacked from asar (configured; untested).
