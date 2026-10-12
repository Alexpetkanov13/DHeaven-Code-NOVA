# ADR-0005: LSP and DAP via external servers, managed by novad

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Language intelligence and debugging must be real, not faked, and hung servers must not affect the UI.

## Decision
Use standard Language Server Protocol and Debug Adapter Protocol. novad spawns/supervises servers; main relays JSON-RPC to the renderer's Monaco adapter (monaco-languageclient-style). Per-request timeouts, cancellation, restart with backoff. Phase 3 starts with Java (Eclipse JDT LS), Kotlin and Gradle; then TypeScript, Python (Pyright/basedpyright), Rust (rust-analyzer).

## Alternatives considered
Own language analysis (infeasible); in-renderer servers (breaks isolation).

## Consequences
+ Reuses best-in-class servers. − Server install/version management, JDK detection, large memory footprints (JDT LS); quality depends on upstream.
