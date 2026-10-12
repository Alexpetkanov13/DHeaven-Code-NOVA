# Development Progress

## Status: Phase 1 (runnable shell) — implemented and verified on Linux; Windows untested

Audit: new repository (no prior codebase). Environment: Linux x64 container, Node 20.19.2, pnpm 10.34.6, Electron 44.7.0, heavily loaded shared machine (timings below are not performance data).

## Verification log (2026-10-12)
| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` (+ manual `node node_modules/electron/install.js`, pnpm skipped Electron's postinstall) | PASS |
| Typecheck | `pnpm typecheck` (TS strict, both packages) | PASS |
| Lint | `pnpm lint` (eslint + typescript-eslint + react-hooks) | PASS |
| Unit tests | `pnpm test` (vitest) | PASS — 22 tests (4 contract, 18 desktop: path guard incl. traversal/UNC/drive/symlink, atomic write, conflict, settings/recent store, tree virtualization, fuzzy) |
| Build | `pnpm build` (Vite renderer + esbuild main/preload) | PASS |
| E2E | `NOVA_E2E_NO_SANDBOX=1 xvfb-run -a pnpm e2e` (Playwright Electron) | PASS — 1 test: security asserts (no require/process, frozen API, CSP header, unknown channel + `../` rejected), open fixture folder, expand, open file, edit, dirty dot, save via command palette, content on disk, no temp files, relaunch shows recent |
| Linux package | `electron-builder --linux AppImage tar.gz` | PASS — `apps/desktop/release/DHeaven-Code-NOVA-0.1.0-linux-x86_64.AppImage`, `...-linux-x64.tar.gz` |
| Packaged smoke | ran `release/linux-unpacked/dheaven-code-nova` under xvfb 40 s | PASS (did not crash; profile created). UI not inspected in packaged build |
| Windows NSIS/portable | `pnpm dist:win` | SKIPPED — no Windows host or Wine here |
| Windows scripts | `scripts/windows/*.ps1/.bat` | NOT RUN — untested on Windows |
| Perf benchmarks | — | NOT DONE |

Screenshot of E2E run: `/workspace/nova-screenshot.png` (outside repo).

## Notes / limitations
- E2E runs Chromium with `--no-sandbox` because the container has no SUID chrome-sandbox. Electron's renderer `sandbox: true` setting is still applied.
- No file watching yet; external changes are only caught by an mtime check on save (conflict prompt).
- Save As only allows targets inside the open workspace.
- No file create/rename/delete in the explorer yet (planned task 1.7 follow-up).
- Rust daemon (novad) deferred to Phase 2 (ADR-0011).
- CSP allows `'unsafe-inline'` styles because Monaco needs them.
- Installers are unsigned. App icon is generated from SVG by `apps/desktop/scripts/render-icon.cjs`.
- Bundle includes all Monaco languages (large); lazy loading is planned.

## Next slice
Explorer file ops + file watcher, then Phase 2 (novad: search, PTY terminal, Git), plus a Windows CI run.
