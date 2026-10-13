# Language servers

Code intelligence (diagnostics, completion, hover, go to definition, references, rename, formatting, code actions) comes from **language servers**. Without one, NOVA still highlights syntax and edits normally. The **Language Servers** view (◇ in the activity bar) shows each server's real state and the capabilities it advertised. A badge is lit only when the running server actually offers that capability.

Servers start only in a **trusted** workspace, because they run project code: Gradle scripts, tsconfig plugins, `cargo check` build scripts and proc macros.

| Language | Server | How it gets installed |
|---|---|---|
| Java | Eclipse JDT LS 1.61.0 | NOVA downloads it after you confirm (pinned URL + SHA-256). Needs a JDK 21+ to run. |
| Kotlin | fwcd kotlin-language-server 1.3.13 | NOVA downloads it after you confirm. Runs on JDK 11–21. |
| TypeScript / JavaScript (incl. TSX/JSX) | typescript-language-server | You install it: `npm install -g typescript-language-server typescript` |
| Python | Pyright (or basedpyright) | You install it: `pipx install pyright` (or `npm install -g pyright`) |
| Rust | rust-analyzer | You install it: `rustup component add rust-analyzer` |

## Servers you install yourself (TypeScript, Python, Rust)
NOVA never downloads these. It looks for the executable in this order:
1. the executable you chose with **Choose Executable…**
2. your `PATH`
3. `~/.cargo/bin`, `~/.local/bin`, and `%APPDATA%\npm` on Windows (or `/usr/local/bin` and `/opt/homebrew/bin` elsewhere)

typescript-language-server and rust-analyzer are run once with `--version` to check that they work. For example, rustup creates a `rust-analyzer` proxy even when the component is not installed, and that proxy fails this check. The card shows where the executable was found and the version it reported. If a server is missing, the card shows the install command. Run it in a terminal, then press **Re-detect**. **Use PATH** forgets a chosen executable.

While typescript-language-server is running, NOVA switches off Monaco's built-in single-file TypeScript checker, so you don't get duplicate suggestions or false "Cannot find module" errors. It switches the checker back on when the server stops.

Progress the server reports (for example rust-analyzer indexing, or `cargo check`) is shown on its card.

## Known limitations
- Python: NOVA does not choose an interpreter or virtual environment yet. Pyright uses the `python` on PATH, or `venvPath`/`venv` from `pyrightconfig.json` or `[tool.pyright]` in `pyproject.toml`. Pyright has no formatter.
- Rust: compiler errors come from `cargo check` after you save. Formatting needs `rustup component add rustfmt`. The workspace (or a direct sub-folder) needs a `Cargo.toml`.
- Go to definition into files outside the workspace (TypeScript `lib.d.ts`, the Rust standard library, JDK classes) is not browsable yet. The Output panel says so.
- No debugger for TypeScript, Python or Rust yet. pytest and `cargo test` run from the Testing view ([testing.md](testing.md)); JavaScript test runners are not wired up yet.
