# ADR-0021: One Python interpreter per workspace for tests, debugger and Pyright

Status: Accepted

## Context
After ADR-0019/0020, pytest runs and debugpy used "workspace venv, else `python3` on PATH", while Pyright used its own default (the `python` on PATH). A project whose packages live in a non-standard venv, a conda env or a pyenv version had no way to point all three at it. They could also disagree, e.g. Pyright reporting unresolved imports that the tests could import fine.

## Decision
- **One resolution order** (`main/python.ts` `resolvePython`), used by the test runner, the debug adapter and Pyright:
  1. the interpreter chosen for this workspace, if it still runs;
  2. the workspace `.venv` / `venv` / `env`;
  3. `python3`/`python` on PATH, as a full path. The Windows Store `WindowsApps` stub is never used.

  A chosen interpreter that stops working is reported (in the panel, the test output and the Debug Console), not silently swapped.
- **Discovery** (`discoverPythons`):
  - Sources: the workspace venvs, PATH, `$PYENV_ROOT/versions/*`, conda base and `envs/*` under `~/miniconda3|anaconda3|miniforge3|mambaforge`, and `py -0p` on Windows.
  - Each candidate is probed by running it (version and real executable; 10 s bound; waits for `close`).
  - Duplicates by real executable are dropped, except workspace venvs, which are kept because their site-packages differ.
- **Selection is stored per workspace** in userData (`workspace-settings.json` `pythonPath`), never in the repository.
  - The renderer can only pick a path from the list main returned last, or open main's native file picker (`python.pick.v1`, which must pass the probe). This is the same rule as server paths: the renderer never names an executable to run.
- **Pyright:** the client now answers `workspace/configuration` per item through `deps.configuration`; Pyright's `python` section gets `{ pythonPath }`. Changing the selection sends `workspace/didChangeConfiguration`, so Pyright pulls it again and re-analyses without a restart.

## Consequences
- Imports, test runs and debugging agree on one environment.
- Not done: creating venvs or installing packages from NOVA, Poetry/PDM/Hatch/uv environment discovery (choose their interpreter with Choose Interpreter…), and per-folder interpreters in multi-root workspaces.
