import { useState } from 'react';

export function InputBox({ title, initial = '', onSubmit, onCancel }: { title: string; initial?: string; onSubmit(v: string): void; onCancel(): void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="palette-backdrop" onMouseDown={onCancel}>
      <div className="palette" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus aria-label={title} placeholder={title} value={v}
          onFocus={(e) => { const dot = initial.lastIndexOf('.'); e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length); }}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter' && v.trim()) onSubmit(v.trim()); }}
        />
      </div>
    </div>
  );
}

export interface MenuItem { label: string; run(): void; danger?: boolean }
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  return (
    <div className="ctx-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it) => (
          <li key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.run(); }}>{it.label}</li>
        ))}
      </ul>
    </div>
  );
}

export function ConfirmBox({ message, confirmLabel, onConfirm, onCancel, extra }: { message: string; confirmLabel: string; onConfirm(): void; onCancel(): void; extra?: { label: string; run(): void } }) {
  return (
    <div className="palette-backdrop" onMouseDown={onCancel}>
      <div className="palette confirm" role="alertdialog" aria-label={message} onMouseDown={(e) => e.stopPropagation()}>
        <p>{message}</p>
        <div className="row-btns">
          {extra && <button className="btn" onClick={extra.run}>{extra.label}</button>}
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" autoFocus onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
