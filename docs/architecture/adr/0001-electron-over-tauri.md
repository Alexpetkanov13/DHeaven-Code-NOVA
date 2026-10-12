# ADR-0001: Electron over Tauri for the desktop shell

- Status: Accepted (planning)
- Date: 2026-10-12

## Context
NOVA needs a mature, consistent rendering engine for Monaco and xterm.js across Windows (primary), later Linux/macOS, plus a proven installer pipeline.

## Decision
Use Electron (current stable) with contextIsolation, sandbox, nodeIntegration off and strict CSP. Heavy native work lives in the Rust daemon, not in Node.

## Alternatives considered
Tauri (smaller binaries, Rust backend, but WebView2/WebKitGTK/WKWebView rendering differences and less-proven Monaco/xterm parity); native UI toolkits (huge rewrite cost, no Monaco).

## Consequences
+ Identical Chromium everywhere, Monaco/xterm first-class, electron-builder NSIS/ZIP. − Larger install (~100+ MB) and higher baseline RAM; must track Electron security releases closely.
