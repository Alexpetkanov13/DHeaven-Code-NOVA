import type { DirEntry } from '@nova/ipc-contract';

export interface Row { entry: DirEntry; depth: number; expanded: boolean }

/** Flatten the visible part of a lazily-loaded tree into rows for virtualization. */
export function flatten(children: Map<string, DirEntry[]>, expanded: Set<string>, rel = '', depth = 0, out: Row[] = []): Row[] {
  for (const e of children.get(rel) ?? []) {
    const isOpen = e.kind === 'dir' && expanded.has(e.rel);
    out.push({ entry: e, depth, expanded: isOpen });
    if (isOpen) flatten(children, expanded, e.rel, depth + 1, out);
  }
  return out;
}

export function visibleRange(scrollTop: number, viewport: number, rowH: number, total: number, overscan = 8) {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowH) + overscan);
  return { start, end };
}
