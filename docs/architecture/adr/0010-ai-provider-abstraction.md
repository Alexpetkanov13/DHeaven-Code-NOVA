# ADR-0010: Provider-independent NOVA AI, off by default

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
Users want AI assistance; many require local-only operation and no silent uploads.

## Decision
A `packages/ai` provider interface (chat, completion, embeddings, streaming, cancellation) with adapters for Ollama (local) and opt-in cloud providers (keys in keychain). Disabled by default. Before any request, the user sees which context is sent. Model edits are proposed as diffs requiring approval. Model output never triggers tool/command execution without confirmation. Workspace content is wrapped as untrusted data with delimiters; instructions inside files are not obeyed.

## Alternatives considered
Single vendor SDK (lock-in); always-on AI (privacy violation).

## Consequences
+ Privacy, flexibility. − Feature parity varies by provider; prompt injection can be mitigated, not eliminated — approval gates are the real defense.
