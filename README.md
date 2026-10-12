# DHeaven Code: NOVA

*Build Beyond Limits.* — an original desktop IDE by **DHeaven**.

**Status:** Phase 1 runnable shell. Verified on Linux (unit + Playwright E2E + Linux package). Windows builds and scripts are untested. See DEVELOPMENT_PROGRESS.md.

- Architecture: [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)
- Decisions: [docs/architecture/adr/](docs/architecture/adr/)
- Plan: [docs/release/DELIVERY_PLAN.md](docs/release/DELIVERY_PLAN.md)
- Progress log: [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md)

Planned stack: Electron + TypeScript (strict) + React + Vite + Monaco, a Rust native daemon (`novad`), xterm.js, LSP/DAP clients, SQLite, pnpm + Cargo workspaces, Playwright, electron-builder (Windows NSIS + portable ZIP).

## Quick start
```
pnpm install
pnpm --filter @nova/desktop build
pnpm --filter @nova/desktop start      # or: pnpm dev
pnpm test && pnpm --filter @nova/desktop e2e
```
Windows: `scripts\windows\setup.bat`, `dev.bat`, `build.bat` (untested).
