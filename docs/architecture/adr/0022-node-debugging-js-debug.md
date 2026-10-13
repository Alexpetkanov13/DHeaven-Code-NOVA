# ADR-0022: Node.js debugging with js-debug; DAP child sessions

Status: Accepted (extends ADR-0014)

## Context
Node's built-in inspector speaks the Chrome DevTools Protocol, not DAP. The standard DAP adapter for Node is Microsoft's vscode-js-debug (MIT). It is published as GitHub release tarballs (`js-debug-dap-v<version>.tar.gz`, whose entry point is `js-debug/src/dapDebugServer.js`), not on npm.

js-debug is multi-session. The client's first session is a launcher, and the debuggee arrives as a reverse `startDebugging` request that the client must answer by opening a second DAP session to the same server.

## Decision
- **User-installed, never downloaded by NOVA.** Same rule as the external language servers (ADR-0018) and debugpy (ADR-0020). NOVA uses the `dapDebugServer.js` the user picks (Choose js-debug…, a native file picker in main, stored main-only in `settings.debugAdapterPaths`), else `<servers dir>/js-debug/src/dapDebugServer.js` if present. When neither exists, Run and Debug shows where to get the release and disables Start.
  - Why not a pinned download like java-debug: pinning needs the official tarball's SHA-256, and this build environment couldn't reach the release assets, so NOVA would have shipped a hash nobody had verified. If the hash is pinned later, the download path can be added with the existing consent-and-verify installer.
- **Adapter** (`main/dap/node.ts`): runs `node dapDebugServer.js 0 127.0.0.1` with the user's `node`. It reads the port from "Debug server listening at host:port" and connects over TCP. The launch config is `pwa-node` with `program`, `args` (shell-like split), `cwd`, `env`, `runtimeExecutable: node`, `console: internalConsole`, `skipFiles: ['<node_internals>/**']` and source maps; attach uses `address`/`port` (default 9229). The server's process tree is killed when the launcher session closes.
- **Child sessions in `DebugManager`, adapter-agnostic:**
  - A factory can return `openChild()`, and the client advertises `supportsStartDebuggingRequest`.
  - On `startDebugging`, the manager opens a child connection and runs the same handshake on it: initialize → launch/attach with the given configuration → `initialized` → breakpoints → configurationDone. The child then becomes the active session for threads, stack, variables, stepping and breakpoint updates.
  - Each connection gets its `initialized` waiter before any request, so the event can't be missed.
  - Stop disconnects children first, then the launcher. A `terminated` event closes every connection of the session.
- **UI:** a Node.js (js-debug) type in Run and Debug, with Program/Arguments/Env/Working dir (launch) or Host/Port (attach), and a js-debug box showing where it was found (or the setup steps) with Choose js-debug… / Forget. The call stack shows file basenames, because js-debug's `source.name` is a full path.
- **CI** builds `dapDebugServer.js` from the pinned `v1.140.0` tag (`npm ci`, `gulp dapDebugServer`) into the servers folder, so the integration test and the E2E run against the real adapter on Linux and Windows.

## Consequences
- Java (java-debug) and Python (debugpy) sessions are unaffected; their real-adapter tests still pass.
- Not done: nested `startDebugging` from a child (worker threads, child processes), browser targets (`pwa-chrome`), running TypeScript directly (use compiled JS with source maps), npm-script launch, and Jest/Vitest test debugging.
