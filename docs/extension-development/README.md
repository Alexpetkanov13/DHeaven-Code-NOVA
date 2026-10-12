# Developing NOVA extensions

NOVA extensions are folders (or `.novaext` packages) with a `nova-extension.json` manifest and, optionally, a CommonJS entry file.

- [Manifest reference](manifest.md)
- [API reference (v1)](api.md)
- [Permissions and security model](security.md)
- [Packaging and installing (`nova-ext`)](packaging.md)

## Quick start

```
my-ext/
  nova-extension.json
  extension.js
```

```json
{
  "manifestVersion": 1,
  "name": "my-ext",
  "publisher": "me",
  "displayName": "My Extension",
  "version": "0.1.0",
  "engines": { "nova": "^0.1.0" },
  "main": "extension.js",
  "activationEvents": ["onCommand:myExt.hello"],
  "contributes": { "commands": [{ "command": "myExt.hello", "title": "Say Hello", "category": "My Ext" }] }
}
```

```js
exports.activate = (nova, context) => {
  const out = nova.window.createOutputChannel('My Ext');
  context.subscriptions.push(nova.commands.registerCommand('myExt.hello', () => { out.appendLine('Hello!'); out.show(); }));
};
```

Then: `nova-ext validate my-ext`, and in NOVA open **Extensions** (Ctrl+Shift+X) → **Install from Folder…**. Run *My Ext: Say Hello* from the Command Palette.

Working examples live in `extensions/examples/`:

| Example | Shows |
|---|---|
| `hello-world` | commands, output channel, status bar item, info message, tree view, setting, task, editor context menu, `globalState`, a permission (`workspace.read`) |
| `custom-theme` | a colour theme applied to Monaco and to the workbench (CSS variables) — declarative, no code |
| `sample-language` | a language (`.nvs`), Monarch grammar, language configuration, snippets — declarative, no code |

Test fixtures that misbehave on purpose (hangs, throws, permission probing) are in `extensions/test-fixtures/`.

## Things to know

- Code only runs in a **trusted** workspace. Declarative contributions (themes, grammars, snippets, languages) also apply in Restricted Mode.
- Extension code runs in a separate **extension host** process, not in NOVA's main or renderer process. A hang or crash kills only the host; the offending extension is quarantined and the host restarts.
- There is no marketplace. Installs are from local files only.
