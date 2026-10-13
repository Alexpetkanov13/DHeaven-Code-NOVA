import type { Settings } from '@nova/ipc-contract';

export function SettingsView({ settings, onChange }: { settings: Settings; onChange(p: Partial<Settings>): void }) {
  return (
    <div className="settings" aria-label="Settings">
      <h2>Settings</h2>
      <label>Editor font size
        <input type="number" min={8} max={40} value={settings.editorFontSize} onChange={(e) => onChange({ editorFontSize: Number(e.target.value) })} />
      </label>
      <label>Tab size
        <input type="number" min={1} max={16} value={settings.editorTabSize} onChange={(e) => onChange({ editorTabSize: Number(e.target.value) })} />
      </label>
      <label>Word wrap
        <input type="checkbox" checked={settings.editorWordWrap} onChange={(e) => onChange({ editorWordWrap: e.target.checked })} />
      </label>
      <label>Minimap
        <input type="checkbox" checked={settings.editorMinimap} onChange={(e) => onChange({ editorMinimap: e.target.checked })} />
      </label>
      <label>Restore last session (workspace, editors, unsaved changes)
        <input type="checkbox" checked={settings.restoreSession} onChange={(e) => onChange({ restoreSession: e.target.checked })} />
      </label>
      <label>Mode
        <select value={settings.mode} onChange={(e) => onChange({ mode: e.target.value as Settings['mode'] })}>
          <option value="focus">Focus</option><option value="nova">NOVA</option>
          <option value="spectra" disabled>Spectra (Phase 8)</option>
        </select>
      </label>
      <p style={{ color: 'var(--nova-text-dim)' }}>Saved to settings.json in the app data folder.</p>
    </div>
  );
}
