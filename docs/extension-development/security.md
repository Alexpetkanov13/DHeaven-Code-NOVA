# Permissions and security model

## Layers (and what each one actually guarantees)

1. **Workspace trust.** No extension code runs in Restricted Mode. Revoking trust stops the extension host. Declarative contributions (themes, grammars, snippets, languages) are data and still apply.
2. **Separate process.** Extension code runs in an *extension host*: the Electron binary started in Node mode (`ELECTRON_RUN_AS_NODE=1`) as a child of the main process, with an empty environment (no inherited secrets), a 512 MB heap cap, and an IPC channel to main. A hang, crash or OOM kills only the host.
3. **Node permission model** on the host process (`--permission`): it may only *read* its own script and the installed-extensions directory. File writes, other reads, `child_process` and worker threads are denied by Node itself (verified in tests: `ERR_ACCESS_DENIED`).
4. **API-level capability checks.** Everything that touches the workspace, network or other programs goes through an RPC to the main process, which checks the calling extension's manifest and the user's grants:
   - a permission **not declared** in the manifest → denied, no prompt;
   - declared but not yet decided → the user is prompted (*Allow / Deny*, optional *Remember*). Unremembered answers last for the session; the prompt times out to *Deny* after 2 minutes;
   - remembered grants are editable in the Extensions view (*Ask / Allow / Deny*).
5. **Module sandbox.** Extension code runs in a `vm` context without `process`, without Node's `require`, with string code generation and WASM disabled, and with a builtin allowlist.

## Honest limits

- **Network is not blocked at the OS/process level.** Node 24's permission model does not restrict sockets. The extension sandbox does not expose `fetch`/`net`, so network access requires the API (and the `network` permission) — **but `vm` is not a security boundary**: code that escapes the vm context (e.g. via host-object prototypes) gets the host's Node runtime. Such code would still be constrained by layer 3 (no file writes, no reads outside the extension directory, no child processes) but could open network connections.
- The host can read every installed extension's files (they are under one allowed directory).
- Electron's `utilityProcess` was evaluated first and rejected: it ignores `--permission` (fs writes, `/etc` reads and `child_process` all succeeded in a probe), so it gives isolation from crashes but not from the OS.
- Not an OS sandbox (no seccomp/AppContainer). Treat extensions as code you run with your user account, minus the restrictions above.

## Crash and hang handling

- Every request to the host has a timeout. A timeout kills the whole host process tree and blames the extension whose request was in flight; that extension is **quarantined** (persisted) until the user re-enables it.
- The host restarts automatically with backoff (500 ms × 2ⁿ); more than 3 crashes in 60 s marks it *failed* until *Restart host*.
- An exception in `activate` marks only that extension as *Error*; others are unaffected.

## Package integrity (`.novaext`)

- Zip entries are validated before extraction: no `..`, absolute paths, drive letters, backslashes, NUL, Windows reserved names, trailing dots/spaces, or case-insensitive duplicates; ≤ 2000 entries, ≤ 20 MB per file, ≤ 100 MB total, ≤ 50 MB archive; real decompressed sizes are re-checked.
- `.nova/integrity.json` lists a SHA-256 for every file; any mismatch or extra/missing file refuses the install.
- If `<file>.novaext.sha256` sits next to the package it must match the archive's SHA-256 or the install is refused. The SHA-256 is shown in the install confirmation.
- Folder installs refuse symlinks. Installs are staged in a temp directory and renamed into place; the previous version is kept for rollback.
- There is **no publisher signature** yet: SHA-256 proves integrity against the sidecar you have, not who published it.
