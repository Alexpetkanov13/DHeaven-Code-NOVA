# ADR-0006: Git through the git CLI

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Git features need full fidelity with the user's config, hooks, credential helpers and LFS.

## Decision
novad invokes the system `git` binary with porcelain v2 / `-z` output parsing, bounded output, timeouts and cancellation. Hooks only run in trusted workspaces.

## Alternatives considered
libgit2/git2-rs (no full hook/credential/LFS parity); gitoxide (fast-improving but incomplete write support); isomorphic-git (slow on large repos).

## Consequences
+ Exact behaviour users expect. − Requires Git installed (detect and guide); output parsing must be robust across versions; process-spawn overhead on Windows.
