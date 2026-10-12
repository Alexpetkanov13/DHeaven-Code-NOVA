# Minecraft Developer Pack (bundled, first-party)

Ships with DHeaven Code: NOVA and is installed automatically (it can be disabled in the Extensions view; a disabled
bundled extension stays disabled). It is declarative only — no extension code runs.

- **New Project templates**: Fabric mod (Minecraft 26.1+) and Paper plugin. Versions are resolved by NOVA core at
  generation time from official sources (Fabric meta/maven, fabric-example-mod, Mojang version metadata; PaperMC Fill
  API/maven, Gradle Plugin Portal). When offline a pinned fallback is used and the wizard + generated build file say so.
- Gradle wrapper (Gradle 9.7.1, Apache-2.0, from the Gradle distribution) is included in generated projects.
- **No Mojang assets** are bundled. Loom / run-paper download Minecraft or Paper themselves when you build or run,
  under their own terms; running a server requires you to accept the Minecraft EULA yourself.

## Also contributes
- `fabric.mod.json`, `pack.mcmeta`, `assets/*/models/**/*.json` JSON Schemas (Monaco JSON diagnostics + completion) and
  `plugin.yml` / `paper-plugin.yml` YAML validation; schemas written for NOVA from the public format docs.
- Gradle run tasks for the **Minecraft** view: Fabric Loom `runClient`/`runServer`, run-paper `runServer`.
  Server tasks require you to accept the Minecraft EULA in a dialog before `run/eula.txt` is written.
- **Skript** (`.sk`): Monarch highlighting, snippets, colon-based indentation. **Syntax only** — no parsing against
  Skript's real syntax registry, no addon awareness, no error checking.
