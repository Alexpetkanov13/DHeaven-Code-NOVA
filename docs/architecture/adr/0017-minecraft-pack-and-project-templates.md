# ADR-0017: Minecraft developer pack as a bundled declarative extension + core template/run-task support

Status: accepted (2026-10-12)

## Context
The Minecraft pack needs project generation with live version lookup, JSON/YAML schema validation, run tasks with
EULA handling and Skript syntax support. The extension API (ADR-0015) runs extension code in a sandboxed host with
no network/process access unless granted; a first-party pack should not need those grants.

## Decision
- `extensions/bundled/minecraft-dev` is a **declarative** extension (no `main`): templates, schemas, snippets, Skript
  grammar/language configuration and run-task descriptors. It is installed at startup through the normal store
  validation/integrity path (`source: bundled:<name>`), can be disabled, cannot be uninstalled, and a user install
  with the same id is never overwritten. Packaged builds ship it under `resources/bundled-extensions`.
- New contribution points, implemented by core and reusable by any extension: `projectTemplates`, `jsonValidation`,
  `yamlValidation`, `gradleRunTasks`.
- **Core template engine** (`src/main/templates`): renders a template folder, fails on unknown variables, refuses
  non-empty targets and unsafe paths. **Resolvers** (fabric, paper) live in core because they fetch from fixed
  official endpoints in main (`net.fetch`); results are cached and generation only accepts versions the user was
  shown. Offline → pinned fallback, labelled in the wizard and in the generated build file.
- Fabric template targets Minecraft 26.1+ only (unobfuscated: no mappings, `net.fabricmc.fabric-loom`, plain
  `implementation`), mirroring the official fabric-example-mod; Loom version is read from that repo.
- YAML validation uses a small CSP-safe JSON-Schema subset validator (ajv needs `new Function`, blocked by CSP) and
  `yaml` AST ranges for marker positions. JSON uses Monaco's built-in JSON service.
- Run tasks are detected **statically** from plugin ids in the root build script (works in Restricted Mode, no Gradle
  run needed). EULA: consent dialog → `runtask.acceptEula.v1` writes `eula.txt`; `gradle.run.v1` independently
  refuses EULA-gated tasks without it. Gradle stdin is now kept open (never written unless the user sends a console
  command) — with stdin closed the Paper console spun on EOF and flooded output.

## Consequences
- Template/resolver additions for new ecosystems need a core change (resolver) but no extension code.
- Static detection misses plugins applied from convention plugins / `buildSrc` / subprojects.
