# ADR-0002: Monaco as the editor component

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
The editor must offer professional features (multi-cursor, minimap, diff editor, LSP-shaped APIs) with fast local input.

## Decision
Use Monaco Editor, bundled locally via Vite (no CDN), with its workers served from the app origin.

## Alternatives considered
CodeMirror 6 (lighter, modular, better mobile/a11y story, but requires building diff view, LSP glue and many IDE affordances); custom editor (not justified).

## Consequences
+ Familiar behaviour, built-in diff editor, LSP-like provider API. − Heavy bundle, inline styles complicate CSP, limited theming beyond tokens; we wrap it behind an `EditorHost` interface to keep a swap possible.
