# Manifest reference (`nova-extension.json`, manifestVersion 1)

Validated strictly (unknown keys are errors) by `@nova/extension-api` `validateManifest` — the same code is used by `nova-ext validate` and by NOVA at install time.

| Field | Required | Notes |
|---|---|---|
| `manifestVersion` | yes | `1` |
| `name` | yes | lowercase `a-z0-9-`, ≤ 64 chars. Extension id = `publisher.name` |
| `publisher` | yes | lowercase `a-z0-9-` |
| `displayName` | yes | ≤ 100 chars |
| `description` | no | ≤ 500 chars |
| `version` | yes | semver `x.y.z[-pre]` |
| `license` | no | SPDX id or text |
| `engines.nova` | yes | semver range (`^0.1.0`, `>=0.1.0 <1`, `*`). Install is refused if the running NOVA version does not satisfy it |
| `main` | no | relative path to a CommonJS file. Omit for declarative-only extensions |
| `permissions` | no | subset of `workspace.read`, `workspace.write`, `network`, `process` — see [security.md](security.md) |
| `activationEvents` | no | `*`, `onStartupFinished`, `onCommand:<id>`, `onLanguage:<id>`, `onView:<id>`. Requires `main` |

## `contributes`

| Key | Shape | Effect in NOVA |
|---|---|---|
| `commands` | `[{ command, title, category? }]` | Command Palette entries `Category: Title`. Must be registered in `activate` with `registerCommand` |
| `menus.commandPalette` | `[{ command, when: "never" }]` | hides a command from the palette |
| `menus["editor/context"]` | `[{ command, when?: "editorLangId == <lang>" }]` | editor right-click menu |
| `configuration` | `{ title?, properties: { key: { type: string\|number\|boolean, default?, description?, enum? } } }` | editable in the Extensions view; read with `nova.workspace.getConfiguration().get(key)` |
| `themes` | `[{ id, label, uiTheme: dark\|light\|hc, path }]` | *Preferences: Color Theme: …* in the palette. Theme file format below |
| `languages` | `[{ id, aliases?, extensions?, configuration? }]` | registers a Monaco language; `configuration` is a Monaco `LanguageConfiguration` JSON |
| `grammars` | `[{ language, format: "monarch", path }]` | Monarch tokenizer JSON (regexes as strings). TextMate grammars are not supported |
| `snippets` | `[{ language, path }]` | VS Code-style snippet JSON (`prefix`, `body`, `description`) |
| `outputChannels` | `[name]` | informational; channels are created at runtime with `createOutputChannel` |
| `views` | `[{ id, name }]` | a collapsible section under the Explorer, backed by `registerTreeDataProvider` |
| `tasks` | `[{ id, label, command }]` | *Tasks: Run <label>* in the palette; runs the command |

Cross-references are checked: menu/task commands must exist in `commands`, grammars/snippets must name a contributed language, activation events need `main`, every referenced file must exist in the package.

## Theme file

```json
{
  "colors":      { "editor.background": "#1E1020" },
  "tokenColors": [{ "token": "keyword", "foreground": "FF7A90", "fontStyle": "italic" }],
  "workbench":   { "nova-cyan": "#FF9E64" }
}
```

`colors` are Monaco colour ids; `tokenColors` are Monaco token rules; `workbench` sets NOVA shell CSS variables. Only `#RRGGBB[AA]` values are accepted, and only these variables: `nova-graphite-900`, `nova-graphite-800`, `nova-navy-900`, `nova-navy-700`, `nova-ultraviolet-800`, `nova-border`, `nova-cyan`, `nova-violet`, `nova-text`, `nova-text-dim`, `nova-danger`. Anything else is dropped, so a theme cannot inject CSS.
