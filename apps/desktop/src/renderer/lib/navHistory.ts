/** Editor navigation history (Go Back / Go Forward). Positions within a few lines of the current one replace it. */
export interface NavLoc { rel: string; line: number; col: number }

export class NavHistory {
  private stack: NavLoc[] = [];
  private idx = -1;
  constructor(private max = 50, private nearLines = 10) {}

  /** Record a location the user moved to. Returns true if a new entry was created. */
  push(loc: NavLoc): boolean {
    const cur = this.stack[this.idx];
    if (cur && cur.rel === loc.rel && Math.abs(cur.line - loc.line) <= this.nearLines) { this.stack[this.idx] = loc; return false; }
    this.stack.splice(this.idx + 1);
    this.stack.push(loc);
    if (this.stack.length > this.max) this.stack.shift();
    this.idx = this.stack.length - 1;
    return true;
  }
  back(): NavLoc | null { if (this.idx <= 0) return null; return this.stack[--this.idx] ?? null; }
  forward(): NavLoc | null { if (this.idx >= this.stack.length - 1) return null; return this.stack[++this.idx] ?? null; }
  canBack() { return this.idx > 0; }
  canForward() { return this.idx < this.stack.length - 1; }
  /** Drop entries for a file that no longer exists (deleted/renamed). */
  forget(rel: string) {
    const cur = this.stack[this.idx];
    this.stack = this.stack.filter((l) => l.rel !== rel);
    this.idx = cur && cur.rel !== rel ? this.stack.indexOf(cur) : this.stack.length - 1;
  }
}
