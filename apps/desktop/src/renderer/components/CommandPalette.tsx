import { useMemo, useState } from 'react';
import { fuzzyScore } from '../lib/fuzzy';

export interface Command { id: string; title: string; detail?: string; keybinding?: string; run(): void }

export interface PickerOptions { label?: string; placeholder?: string; empty?: string; /** keep source order (no fuzzy sort) when the query is empty */ keepOrder?: boolean }

export function CommandPalette({ commands, onClose, label = 'Command Palette', placeholder = 'Type a command…', empty = 'No matching commands', keepOrder }: { commands: Command[]; onClose(): void } & PickerOptions) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const items = useMemo(
    () => commands.map((c) => ({ c, s: fuzzyScore(q, c.title) })).filter((x) => x.s >= 0).sort((a, b) => (keepOrder && !q ? 0 : b.s - a.s)).slice(0, 200).map((x) => x.c),
    [commands, q, keepOrder],
  );
  const run = (c?: Command) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={label} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label={placeholder}
          placeholder={placeholder}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(items[idx]); }
          }}
        />
        <ul role="listbox">
          {items.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === idx} className={i === idx ? 'active' : ''} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              <span>{c.title}{c.detail && <small className="pick-detail">{c.detail}</small>}</span>{c.keybinding && <kbd>{c.keybinding}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li>{empty}</li>}
        </ul>
      </div>
    </div>
  );
}
