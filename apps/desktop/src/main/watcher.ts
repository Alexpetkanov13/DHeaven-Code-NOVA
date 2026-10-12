import fs from 'node:fs';
import path from 'node:path';

const IGNORE = /(^|\/)(\.git|node_modules)(\/|$)|\.nova-[0-9a-f]+\.tmp$/;

/** Recursive fs.watch with coalescing: emits a deduplicated batch of workspace-relative paths at most every `delayMs`. */
export class CoalescingWatcher {
  private w: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private root: string, private emit: (rels: string[]) => void, private delayMs = 150, private maxBatch = 2000) {}

  start() {
    this.w = fs.watch(this.root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const rel = file.toString().split(path.sep).join('/');
      if (IGNORE.test(rel)) return;
      if (this.pending.size < this.maxBatch) this.pending.add(rel);
      this.timer ??= setTimeout(() => this.flush(), this.delayMs);
    });
    this.w.on('error', () => this.stop());
    return this;
  }
  private flush() {
    this.timer = null;
    const rels = [...this.pending];
    this.pending.clear();
    if (rels.length) this.emit(rels);
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.w?.close();
    this.w = null;
  }
}
