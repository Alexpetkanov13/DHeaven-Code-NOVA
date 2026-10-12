import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '@nova/ipc-contract';
import { flatten, visibleRange } from '../lib/tree';

const ROW_H = 22;

interface Props {
  children: Map<string, DirEntry[]>;
  expanded: Set<string>;
  selected: string | null;
  onToggle(rel: string): void;
  onOpen(rel: string): void;
}

/** Virtualized file tree: only rows in the viewport (+overscan) are rendered. */
export function Explorer({ children, expanded, selected, onToggle, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const rows = useMemo(() => flatten(children, expanded), [children, expanded]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { start, end } = visibleRange(scroll, height, ROW_H, rows.length);
  return (
    <div className="tree" ref={ref} role="tree" aria-label="Explorer" tabIndex={0} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * ROW_H }} />
      {rows.slice(start, end).map((r, i) => (
        <div
          key={r.entry.rel}
          role="treeitem"
          aria-expanded={r.entry.kind === 'dir' ? r.expanded : undefined}
          aria-selected={selected === r.entry.rel}
          data-rel={r.entry.rel}
          className={`row${selected === r.entry.rel ? ' sel' : ''}`}
          style={{ top: (start + i) * ROW_H, paddingLeft: 8 + r.depth * 14 }}
          onClick={() => (r.entry.kind === 'dir' ? onToggle(r.entry.rel) : onOpen(r.entry.rel))}
        >
          <span className="tw">{r.entry.kind === 'dir' ? (r.expanded ? '▾' : '▸') : ''}</span>
          {r.entry.name}
        </div>
      ))}
    </div>
  );
}
