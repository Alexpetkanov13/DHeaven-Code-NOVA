import { useMemo, useState } from 'react';
import { fuzzyScore } from '../lib/fuzzy';

export interface Command { id: string; title: string; keybinding?: string; run(): void }

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const items = useMemo(
    () => commands.map((c) => ({ c, s: fuzzyScore(q, c.title) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c),
    [commands, q],
  );
  const run = (c?: Command) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command Palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label="Type a command"
          placeholder="Type a command…"
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
              <span>{c.title}</span>{c.keybinding && <kbd>{c.keybinding}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li>No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
