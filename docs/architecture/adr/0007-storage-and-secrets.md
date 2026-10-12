# ADR-0007: SQLite metadata, JSON/TOML config, OS keychain secrets

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
We need durable app state (recents, indexes, session), human-editable settings, and safe secret storage.

## Decision
SQLite (via `rusqlite` in novad) for metadata/caches with migrations; user/workspace settings in JSON (with comments) and TOML for project-level NOVA config, schema-validated; secrets (AI keys, tokens) in OS keychain (Windows Credential Manager, macOS Keychain, libsecret) — never in files or logs. All paths derive from OS app-data dirs.

## Alternatives considered
Everything in JSON (corruption, no queries); encrypted file vault (key management burden); LevelDB/IndexedDB in renderer (violates isolation).

## Consequences
+ Robust, inspectable, secure. − Migration discipline required; libsecret absent on some Linux setups (fallback: safeStorage with warning).
