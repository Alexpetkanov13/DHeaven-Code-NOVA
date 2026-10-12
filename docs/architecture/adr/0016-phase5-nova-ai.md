# ADR-0016: Phase 5 — NOVA AI implementation

Status: Accepted (Phase 5). Implements ADR-0010 with the deviations noted below.

## Decision
- `packages/ai-core` (not `packages/ai`): provider interface **v1** (`apiVersion: 1`; `listModels`, streaming `chat`; cancellation via `AbortSignal`), adapters `OllamaProvider` (`/api/chat`, NDJSON) and `OpenAiCompatibleProvider` (`/chat/completions`, SSE), `chatWithRetry` (overall timeout, idle timeout, retry with backoff only for retryable errors **before the first token**). Also context exclusion, redaction, untrusted-data prompt building and the diff-hunk engine — all pure and unit-tested.
- `AiService` in Electron main owns config (`<userData>/ai/ai.json`), keys (`safeStorage`, refuses `basic_text`), per-workspace history and all network I/O. Two-step protocol: `ai.prepare.v1` returns the exact payload; `ai.send.v1 {id}` sends that stored payload unchanged (one send per preview).
- Renderer: AI panel, preview dialog, inline-diff dialog; inline edits are applied by the renderer to the open model and saved through the normal `fs.write.v1` path, only for accepted hunks, and refused if the text changed since the request.
- No tool calling. Proposed commands are parsed from ```sh blocks and only displayed.

## Deviations from ADR-0010
- No completion or embeddings API yet (chat only).
- Inline-completion (ghost text) not implemented.

## Consequences
- Every request costs one extra click (preview). Intentional.
- Small local models give poor answers; the plumbing is model-independent.
