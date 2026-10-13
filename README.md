# DHeaven Code: NOVA

*Build Beyond Limits.* — an original desktop IDE by **DHeaven**.

**Status:** Phases 1–6 + the Minecraft developer pack, plus language servers for Java, Kotlin, TypeScript/JavaScript, Python and Rust. CI (unit + Playwright Electron E2E) runs on Linux and Windows; the Windows installer is built but unsigned. What is verified, and what is not, is in DEVELOPMENT_PROGRESS.md.

- Architecture: [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)
- Decisions: [docs/architecture/adr/](docs/architecture/adr/)
- Plan: [docs/release/DELIVERY_PLAN.md](docs/release/DELIVERY_PLAN.md)
- Progress log: [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md)
- User guide: [language servers](docs/user-guide/language-servers.md), [NOVA AI privacy](docs/privacy/NOVA-AI.md), [extension development](docs/extension-development/README.md)

Stack: Electron + TypeScript (strict) + React + Vite + Monaco, a Rust native daemon (`novad`), xterm.js, LSP/DAP clients, SQLite, pnpm + Cargo workspaces, Playwright, electron-builder (Windows NSIS + portable ZIP).

## Quick start
```
pnpm install
pnpm --filter @nova/desktop build
pnpm --filter @nova/desktop start      # or: pnpm dev
pnpm test && pnpm --filter @nova/desktop e2e
```
Windows: `scripts\windows\setup.bat`, `dev.bat`, `build.bat` (untested).
