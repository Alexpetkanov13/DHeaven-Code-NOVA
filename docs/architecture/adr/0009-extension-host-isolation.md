# ADR-0009: Extension host isolation with capability permissions

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Extensions add value but are the largest risk to stability and security.

## Decision
Run extensions in a separate Electron `utilityProcess` with no direct Node fs/child_process/net access exposed through the API; extensions declare capabilities in their manifest (e.g. `workspace.read`, `workspace.write`, `terminal`, `network:<host>`), the user grants them, main enforces them. Watchdog kills unresponsive hosts; UI degrades gracefully.

## Alternatives considered
VS Code extension compatibility (huge API surface, licensing/marketplace terms); in-renderer extensions (unsafe); WASM-only extensions (good future option, limited ecosystem now).

## Consequences
+ Bounded blast radius. − Own ecosystem must be grown; Node-level sandboxing isn't perfect, so capability enforcement relies on API mediation and process limits.
