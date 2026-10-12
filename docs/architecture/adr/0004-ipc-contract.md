# ADR-0004: Typed, versioned, validated IPC contract

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Security and stability depend on the renderer only being able to request well-defined operations.

## Decision
Define all channels in `packages/ipc-contract` with zod schemas, names `<domain>.<action>.vN`, request/response envelopes with error codes, cancellation tokens and deadlines. Validate in main and again in novad. Export JSON Schema for Rust contract tests.

## Alternatives considered
Ad-hoc ipcRenderer channels (unsafe, drift); gRPC/protobuf (heavier tooling, less ergonomic in renderer); tRPC (TS-only, no Rust side).

## Consequences
+ Single source of truth, safe evolution, testable. − Schema maintenance cost; small validation overhead per message (to be measured).
