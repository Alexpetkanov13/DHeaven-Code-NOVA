# Extension API v1 (`API_VERSION = "1.0.0"`)

Types: `packages/extension-api/src/api.ts`. The API object is **passed to** `activate(nova, context)`; there is no `require('nova')`.

```js
exports.activate = async (nova, context) => { /* ... */ };
exports.deactivate = async () => {};
```

## `nova.commands`
- `registerCommand(id, handler)` → Disposable. `id` must be declared in `contributes.commands`. Return values must be JSON-serialisable.
- `executeCommand(id, ...args)` — runs another extension's command (activating it if needed).

## `nova.window`
- `showInformationMessage / showWarningMessage / showErrorMessage(text)` — toast + a line in the NOVA output.
- `createOutputChannel(name)` → `{ append, appendLine, clear, show }`. Channels appear in the Output panel selector (1 MB cap per channel).
- `createStatusBarItem()` → `{ text, tooltip, command, show(), hide(), dispose() }`.
- `registerTreeDataProvider(viewId, { getChildren(element?) })` → `{ refresh(), dispose() }`. Items: `{ id?, label, description?, tooltip?, collapsible?, command?, commandArgs? }` (max 1000 children per call).

## `nova.workspace`
- `getConfiguration().get(key)` — values from `contributes.configuration` with the user's overrides.
- `readFile(rel)`, `listDir(rel)` — **permission `workspace.read`**. Paths are workspace-relative; escaping the workspace is rejected.
- `writeFile(rel, content)` — **permission `workspace.write`**.

## `nova.net`
- `fetch(url, { method?, headers?, body? })` → `{ status, ok, headers, text }` — **permission `network`**. http/https only; body capped at 5 MB. Performed by NOVA's main process.

## `nova.process`
- `exec(command, args)` → `{ code, stdout, stderr, timedOut }` — **permission `process`**. No shell; cwd = workspace root; 60 s timeout.

## `context`
- `extensionId`, `extensionPath`, `subscriptions` (disposed on deactivate), `globalState.get/update` (persisted JSON per extension).

## Runtime environment
- The module runs in a `vm` context with standard JS globals plus `console` (goes to the extension's log in the Extensions view), timers, `URL`, `TextEncoder/Decoder`, `structuredClone`.
- `require` resolves relative files inside the extension and these builtins only: `path`, `util`, `events`, `url`, `assert`, `buffer`, `string_decoder`, `querystring`. `fs`, `child_process`, `net`, `http`, `worker_threads`, … are not available — use the API.
- `eval`/`new Function` and WebAssembly compilation are disabled.
- Requests to NOVA time out (commands: 10 s by default). A command that does not return in time is treated as a hang: the host is killed and the extension quarantined.
