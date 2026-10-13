# ADR-0019: Testing view for Gradle/JUnit, pytest, cargo test, Vitest and Jest

Status: Accepted (extends ADR-0014)

## Context
The Testing view handled only Gradle + JUnit. With TS/Python/Rust language servers in place (ADR-0018), the next most useful step was running Python and Rust tests from the IDE. Results must come from the tools themselves, never be inferred.

## Decision
- **Frameworks:** `gradle` (unchanged behavior), `pytest` and `cargo`. Every test node and result carries its `framework`. Node ids are the framework's own names:
  - Gradle: `pkg.Class.method`
  - pytest: node ids `file::Class::test[param]`
  - libtest: `module::path::fn`

  So reruns pass ids straight back to the tool.
- **Discovery is a static source scan for all three**, as it already was for JUnit. Collecting with the tool itself (`pytest --collect-only`, `cargo test -- --list`) would import conftest files and run build scripts and proc macros, i.e. execute workspace code before the user trusted it.
  - pytest: `test_*` functions and `Test*` class methods in `test_*.py` / `*_test.py`.
  - Rust: `#[test]` / `#[…::test]` functions. The module path comes from the file layout plus inline `mod` blocks.

  Tests created by fixtures, plugins or macros aren't listed, but still run and are counted.
- **Results come from each tool's report:**
  - Gradle: JUnit XML, as before.
  - pytest: `--junitxml` with `junit_family=xunit1`, which carries `file`, so a result maps back to its node id. Captured output comes via `junit_logging=out-err`; `--rootdir` is the workspace and `--color=no` is set.
  - cargo: stable Rust has no JSON test output, so libtest's text is parsed (`test X ... ok|FAILED|ignored[, reason]` lines and `---- X stdout ----` sections). `--show-output` captures passing tests' stdout too. libtest reports no per-test durations, so `timeMs` is `null` (the contract allows that) rather than a fake 0.
- **Runs:** `tests.run.v1` takes `targets: [{framework, filters}]`; an empty list means every framework that has discovered tests. Main runs the targets one after another as one run with one run id; Cancel kills the current process tree and stops the chain.
  - Filters are separate argv entries, never a shell, and may not start with `-`.
  - Gradle filters keep the old strict alphabet.
  - pytest ids follow `--`; cargo filtered runs use `--exact`.
- **Interpreter:** the project virtualenv (`.venv`, `venv`, `env`) if present, else `python3` (or `python` on Windows). The run output names the interpreter used. If pytest isn't installed for it, the run says so plainly.
- **Trust:** running needs a trusted workspace, as before. Discovery needs no trust because nothing executes.
- **Debugging** a single test: Gradle (`--debug-jvm` + attach); pytest under debugpy since ADR-0020. Other frameworks get no Debug button.

## Consequences
- The UI groups tests by file. Group runs use each framework's natural filter: a class for Gradle, a file or class node id for pytest, exact leaf names for cargo, since a cargo group is not a libtest name.
- Parametrized pytest results (`test[x]`) roll up into their function's node, and the details pane lists every variant.

## Addendum: Vitest and Jest
- **Detection:** the root `package.json` lists `vitest` (preferred) or `jest`. Monorepo sub-packages aren't searched yet.
- **Static discovery:**
  - Files: `*.test|spec.[cm]?[jt]sx?` and `__tests__/`.
  - `describe`/`suite` with string-literal names (nesting by braces, with strings and comments stripped), and `it`/`test` with `.skip`/`.only`/`.todo`/`.concurrent`… modifiers.
  - Not listed (still run and counted): dynamic names, `.each`, and calls like `it.skipIf(c)(…)`.
  - Ids are `file::describe > test`, which is Vitest's own `>`-joined JUnit name and Jest's `ancestorTitles + title`.
- **Launch:** runners start as `node <node_modules/<runner>/bin entry>`. `node` comes from PATH (plus the usual extra dirs). No shell and no `.cmd` shims, so test names with cmd metacharacters are safe on Windows. If the runner isn't installed, the run says to run the package manager's install.
- **Reports:**
  - Vitest: `--reporter=default --reporter=junit --outputFile.junit=<tmp>`. `classname` is the file and `name` is `a > b`; captured `console.log` is included.
  - Jest: `--json --outputFile=<tmp> --testLocationInResults --ci`. A file that fails to load becomes one `error` result; `todo` counts as skipped. Jest's JSON has no per-test console output.
- **Filters:** whole files are positional args (for Jest, a regex escaped to accept either path separator). Named tests become `-t ^(?:full name|…)$`, which both runners match against the space-joined full name. A run mixing whole files and named tests uses two invocations, so `-t` doesn't narrow the whole-file part.
- `NO_COLOR=1` / `FORCE_COLOR=0` keep the output pane free of escape codes.
- Not done: node:test, Mocha, debugging JS tests.
