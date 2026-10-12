# ADR-0011: Phase 1 keeps filesystem access in the main process (novad deferred)

- Status: Accepted (temporary)
- Date: 2026-10-12
- Amends: ADR-0003

## Context
ADR-0003 puts privileged work in a Rust daemon. Phase 1 only needs list/read/write of workspace files; building the daemon first would delay a runnable shell.

## Decision
For Phase 1, fs operations live in `apps/desktop/src/main/workspaceFs.ts`, behind the same zod-validated IPC contract. Paths are workspace-relative, canonicalized, symlink-checked (`pathGuard.ts`), size-capped (32 MB read), and writes are atomic (temp + fsync + rename). File watching, search, PTY and Git arrive with `novad` in Phase 2.

## Alternatives
Build novad now (slower to first runnable slice).

## Consequences
+ Runnable app sooner; renderer API unchanged when novad lands. − Large reads run on main's event loop (async, capped) until moved; no external-change watching yet (conflicts caught by mtime check on save only).
