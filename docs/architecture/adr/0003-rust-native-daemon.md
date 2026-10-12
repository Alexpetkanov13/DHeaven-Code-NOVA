# ADR-0003: Rust native daemon (novad) for privileged work

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
File watching, search, PTY and process-tree management are CPU/IO heavy and must never block Electron's main event loop.

## Decision
Implement `novad` in Rust with Tokio, `notify` for watching, `ignore`+`grep-searcher` for search, `portable-pty` for terminals, and a process supervisor (Windows Job Objects / Unix process groups). One daemon per app instance, spawned and supervised by main.

## Alternatives considered
Node native addons (crash takes down main); pure Node (event-loop contention); per-feature binaries (more processes, duplicated plumbing).

## Consequences
+ Isolation, performance, memory safety. − Two toolchains (pnpm + Cargo), cross-compilation for ARM64, IPC serialization overhead; daemon crashes need restart and state rehydration.
