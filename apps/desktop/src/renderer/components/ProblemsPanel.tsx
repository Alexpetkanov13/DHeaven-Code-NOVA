export interface ProblemItem { uri: string; rel: string; line: number; col: number; severity: 'error' | 'warning' | 'info'; message: string; source: string }

export function ProblemsPanel({ items, onOpen, onExplain }: { items: ProblemItem[]; onOpen(p: ProblemItem): void; onExplain?(p: ProblemItem): void }) {
  if (!items.length) return <div className="panel-body muted">No problems have been detected.</div>;
  const by = new Map<string, ProblemItem[]>();
  for (const p of items) by.set(p.rel, [...(by.get(p.rel) ?? []), p]);
  return (
    <div className="panel-body problems" role="list" aria-label="Problems">
      {[...by].map(([rel, ps]) => (
        <div key={rel}>
          <div className="file">{rel} <span className="muted">{ps.length}</span></div>
          {ps.map((p, i) => (
            <div key={i} role="listitem" className={`prob sev-${p.severity}`} onClick={() => onOpen(p)}>
              <span className="sev">{p.severity === 'error' ? '⛔' : p.severity === 'warning' ? '⚠' : 'ℹ'}</span> {p.message} <span className="muted">[{p.source}] Ln {p.line}, Col {p.col}</span>{onExplain && <button className="link small" title="Explain with NOVA AI (shows the request first)" onClick={(e) => { e.stopPropagation(); onExplain(p); }}>Explain with AI</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
