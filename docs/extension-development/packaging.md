# Packaging and installing

## `nova-ext` CLI (`packages/extension-api`)

```
pnpm --filter @nova/extension-api build        # produces packages/extension-api/bin/nova-ext.cjs
node packages/extension-api/bin/nova-ext.cjs validate <folder | file.novaext>
node packages/extension-api/bin/nova-ext.cjs pack <folder> [-o out.novaext]
```

- `validate` checks the manifest (schema + cross-references + referenced files) and, for packages, archive safety and integrity. Exit code 1 with one line per problem.
- `pack` validates, then writes `<publisher>.<name>-<version>.novaext` (a zip with `nova-extension.json` at the root plus `.nova/integrity.json`) and `…novaext.sha256`. Ship both files.

## Installing in NOVA

Extensions view (Ctrl+Shift+X): **Install from .novaext…** or **Install from Folder…**. A confirmation shows the source, SHA-256, sidecar status, requested permissions and contributions. Installing an id that is already installed is an **update**; the previous version is kept and **Roll back** swaps back to it. **Disable** stops the extension and keeps it installed; **Uninstall** removes it.

State lives in `<userData>/extensions/state.json`, files in `<userData>/extensions/<id>/<version>/` (override with `NOVA_EXTENSIONS_DIR`).
