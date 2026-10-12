import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchMatch } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';

interface Props { onOpen(rel: string, line: number, col: number): void; onError(e: unknown): void; onLog(t: string): void }

export function SearchView({ onOpen, onError, onLog }: Props) {
  const [query, setQuery] = useState('');
  const [isRegex, setRegex] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState('');
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    const a = on('search.matches.v1', (p) => { if (p.searchId === idRef.current) setMatches((m) => [...m, ...p.matches]); });
    const b = on('search.done.v1', (p) => {
      if (p.searchId !== idRef.current) return;
      setStatus(`${p.total} result${p.total === 1 ? '' : 's'}${p.truncated ? ' (limit reached)' : ''}${p.cancelled ? ' (cancelled)' : ''}`);
    });
    return () => { a(); b(); };
  }, []);

  const run = async () => {
    if (idRef.current !== null) void call('search.cancel.v1', { searchId: idRef.current }).catch(() => {});
    setMatches([]);
    if (!query) { idRef.current = null; setStatus(''); return; }
    setStatus('Searching…');
    try { idRef.current = (await call('search.start.v1', { query, isRegex, caseSensitive })).searchId; }
    catch (e) { setStatus('Search failed'); onError(e); }
  };
  useEffect(() => { const t = setTimeout(() => void run(), 250); return () => clearTimeout(t); }, [query, isRegex, caseSensitive]); // eslint-disable-line react-hooks/exhaustive-deps

  const byFile = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const x of matches) m.set(x.rel, [...(m.get(x.rel) ?? []), x]);
    return m;
  }, [matches]);

  const replaceAll = async () => {
    const rels = [...byFile.keys()];
    if (!rels.length || !window.confirm(`Replace ${matches.length} occurrence(s) in ${rels.length} file(s)?`)) return;
    try {
      const r = await call('replace.apply.v1', { query, isRegex, caseSensitive, replacement, rels });
      onLog(`Replaced ${r.replacements} occurrence(s) in ${r.files} file(s)`);
      void run();
    } catch (e) { onError(e); }
  };

  return (
    <div className="view" aria-label="Search">
      <input type="text" aria-label="Search query" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
      <div className="toggles">
        <label><input type="checkbox" checked={caseSensitive} onChange={(e) => setCase(e.target.checked)} />Aa</label>
        <label><input type="checkbox" checked={isRegex} onChange={(e) => setRegex(e.target.checked)} />.*</label>
      </div>
      <input type="text" aria-label="Replace with" placeholder="Replace (preview below)" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
      <div className="toggles"><button className="btn small" disabled={!matches.length || !replacement} onClick={() => void replaceAll()}>Replace All</button><span role="status" aria-label="Search status">{status}</span></div>
      <ul className="results" aria-label="Search results">
        {[...byFile].map(([rel, ms]) => (
          <li key={rel}>
            <div className="file">{rel} <span className="muted">{ms.length}</span></div>
            {ms.slice(0, 200).map((m, i) => (
              <div key={i} className="hit" title={`${rel}:${m.line}`} onClick={() => onOpen(m.rel, m.line, m.start + 1)}>
                <span className="muted">{m.line}: </span>
                {m.text.slice(Math.max(0, m.start - 40), m.start)}
                {replacement ? <><del>{m.text.slice(m.start, m.end)}</del><ins>{replacement}</ins></> : <mark>{m.text.slice(m.start, m.end)}</mark>}
                {m.text.slice(m.end, m.end + 80)}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
