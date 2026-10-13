# Debugging

Open **Run and Debug** (▷), press **New**, choose a **Type**, fill in the fields, then **Save** and **▶ Start**. Debugging runs your code, so it needs a trusted folder. Set or remove a breakpoint with F9 or by clicking the gutter.

## Java
Uses Microsoft's java-debug inside the Java language server (JDT LS). NOVA downloads java-debug only after you confirm. Fields: main class (auto-detected if empty), program and VM arguments, environment, working directory, JDK, and an optional Gradle task to run first (e.g. `classes`). **Attach** connects to a JVM started with JDWP (e.g. `gradle test --debug-jvm`, which the Testing view's 🐞 does for you).

## Python
Uses **debugpy**, which you install yourself into the Python NOVA uses:

```
python -m pip install debugpy
```

NOVA uses the folder's Python interpreter: the one chosen in the **Python** card of the Language Servers view, else the folder's `.venv`, `venv` or `env`, else `python3` (`python` on Windows). The first line in the Debug Console shows which Python and which debugpy version ran. Fields:
- **Program:** a script path (e.g. `app/main.py`), **or Module:** run with `-m` (e.g. `app.main`, `pytest`).
- **Arguments:** quotes group words (`"a b"`).
- **Env, Working dir.**
- **Just my code** (on by default): skips library code when stepping.

**Attach** connects to a process started with `python -m debugpy --listen 5678 …`.

To debug one pytest test, press 🐞 next to it in the Testing view. It runs `python -m pytest -q "<test id>"` under debugpy.

## Node.js
Uses Microsoft's **js-debug** (MIT), which you download yourself:
1. Download `js-debug-dap-v<version>.tar.gz` from https://github.com/microsoft/vscode-js-debug/releases and extract it.
2. In Run and Debug, create a config with Type **Node.js (js-debug)** and press **Choose js-debug…**. Pick `js-debug/src/dapDebugServer.js` from the extracted folder.

NOVA runs it with the `node` on your PATH, which also runs your program. Fields:
- **Program:** e.g. `src/main.js`.
- **Arguments, Env, Working dir.**

**Attach** connects to `node --inspect=9229 …`. TypeScript: debug the compiled JavaScript; source maps map breakpoints back to your `.ts` files.

## Limitations
- One debug session at a time.
- No exception-breakpoint settings yet.
- No Rust debugger yet. Node.js: no worker-thread/child-process sessions, no browser debugging, no debugging of Jest/Vitest tests.
