# ADR-0008: Workspace trust

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Opening a repository must not execute its code. Tasks, debug configs, LSP commands, extensions and Git hooks can all run arbitrary programs.

## Decision
Every workspace starts untrusted unless its path is in the user's trusted list. Restricted mode allows browsing/editing/search; blocks tasks, debug launch, workspace-specified binaries, workspace extensions, and hook-running Git ops. Trust is granted explicitly per folder (optionally parent), stored in SQLite, revocable.

## Alternatives considered
Trust everything (unsafe); per-action prompts only (prompt fatigue).

## Consequences
+ Clear safety boundary. − Some friction on first open; every feature must declare whether it is trust-gated (enforced in main).
