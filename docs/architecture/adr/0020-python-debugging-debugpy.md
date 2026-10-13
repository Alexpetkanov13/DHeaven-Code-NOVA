# ADR-0020: Python debugging with debugpy

Status: Accepted (extends ADR-0014)

## Context
NOVA's DAP layer (ADR-0014) was written generic: `DebugManager` takes one adapter factory per config type. Until now only Java (java-debug inside JDT LS) was wired in. Python is the next language with both a language server (ADR-0018) and a test runner (ADR-0019).

## Decision
- **debugpy, installed by the user** (`python -m pip install debugpy`), the same rule as the external language servers: NOVA never downloads it.
- **Interpreter:** the same one the Testing view uses (workspace `.venv`/`venv`/`env`, else `python3`/`python`).
  - Before starting, NOVA runs `<python> -c "import debugpy; print(debugpy.__version__)"`.
  - If debugpy is missing, the session fails with the interpreter's path and the exact pip command.
  - The Debug Console's first line names the interpreter and the debugpy version.
- **Transport:** the adapter runs as `<python> -m debugpy.adapter` over stdio (`Duplex.from` stdout/stdin into the existing `DapConnection`). It starts in its own process group, and its tree is killed when the connection closes, so a debuggee that ignores `disconnect` still ends.
- **Launch config** (`type: 'python'`):
  - `program` (a script relative to the workspace) or `module` (`-m`), never both.
  - `args` is split like a shell for plain words (quotes and escapes; no variables or globs).
  - Also `cwd`, `env`, and `justMyCode` (default on).
  - `console: internalConsole`, so output goes to NOVA's Debug Console.
  - `attach` connects to `python -m debugpy --listen <port>`.
- **Debugging a pytest test:** the Testing view's 🐞 on a pytest test starts `module: pytest, args: -q "<node id>"` under debugpy. Breakpoints in the test or the code under test stop as usual.
- **UI:** a Type selector in the launch-config form. The Java-only fields and the java-debug install banner are hidden for Python. The call stack falls back to the file name from `source.path` when an adapter (debugpy) sends no `source.name`.

## Consequences
- Breakpoints (conditional, hit-count and logpoints, gated by capabilities), stepping, variables, watch and evaluate work unchanged, because they were adapter-agnostic.
- Not done: exception breakpoints UI (NOVA still sends an empty filter list), subprocess debugging, remote path mappings for attach, an interpreter picker.
