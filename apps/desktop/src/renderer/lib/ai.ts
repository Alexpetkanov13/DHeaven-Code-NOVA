import type { AiConfigInfo, AiDone, AiHistoryEntry, AiPreview, Req } from '@nova/ipc-contract';
import { applyHunks, diffHunks, type Hunk } from '@nova/ai-core/src/diff';
import { call, on } from './ipc';

export type PrepareReq = Req<'ai.prepare.v1'>;
export interface InlineTarget { rel: string; startLine: number; endLine: number; original: string; instruction: string }
export interface InlineEdit extends InlineTarget { hunks: Hunk[]; decision: Map<number, 'accept' | 'reject'> }
export interface Current { requestId: string; action: string; text: string; status: string | null; done: AiDone | null; inline?: InlineTarget; provider: string; model: string }

/** Recent terminal output, so it can be attached (as untrusted data) when the user opts in. */
let terminalTail = '';
on('terminal.data.v1', (p) => { try { terminalTail = (terminalTail + new TextDecoder().decode(Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)))).slice(-8000); } catch { /* ignore */ } });
export const recentTerminal = () => terminalTail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Renderer state for NOVA AI. Network calls happen in main; this only drives IPC. */
export class AiClient {
  config: AiConfigInfo | null = null;
  history: AiHistoryEntry[] = [];
  preview: (AiPreview & { inline?: InlineTarget }) | null = null;
  current: Current | null = null;
  inline: InlineEdit | null = null;
  private subs = new Set<() => void>();
  private offs: (() => void)[] = [];
  constructor(private onError: (e: unknown) => void) {
    this.offs.push(
      on('ai.token.v1', (e) => { if (this.current?.requestId === e.requestId) { this.current = { ...this.current, text: this.current.text + e.token, status: null }; this.notify(); } }),
      on('ai.status.v1', (e) => { if (this.current?.requestId === e.requestId) { this.current = { ...this.current, status: e.message }; this.notify(); } }),
      on('ai.done.v1', (e) => {
        if (this.current?.requestId !== e.requestId) return;
        this.current = { ...this.current, text: e.text, done: e, status: null };
        const t = this.current.inline;
        if (t && !e.error && !e.cancelled) {
          if (e.code === null) this.current = { ...this.current, status: 'The model did not return a code block; nothing to apply.' };
          else { const hunks = diffHunks(t.original, e.code); this.inline = { ...t, hunks, decision: new Map() }; if (!hunks.length) this.current = { ...this.current, status: 'The model returned identical code.' }; }
        }
        void this.loadHistory(); this.notify();
      }),
    );
  }
  dispose() { for (const o of this.offs) o(); }
  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private notify() { for (const f of this.subs) f(); }
  async refresh() { try { this.config = await call('ai.getConfig.v1', {}); await this.loadHistory(); } catch (e) { this.onError(e); } this.notify(); }
  async loadHistory() { try { this.history = await call('ai.history.v1', {}); } catch { this.history = []; } this.notify(); }
  async setConfig(p: Req<'ai.setConfig.v1'>) { try { this.config = await call('ai.setConfig.v1', p); } catch (e) { this.onError(e); } this.notify(); }
  get enabled() { return !!this.config?.enabled; }
  get active() { return this.config?.providers.find((p) => p.id === this.config!.activeProvider) ?? null; }

  /** Step 1: main builds the exact payload; the user sees it before anything is sent. */
  async ask(req: PrepareReq, inline?: InlineTarget) {
    try { this.preview = { ...(await call('ai.prepare.v1', req)), ...(inline ? { inline } : {}) }; } catch (e) { this.onError(e); }
    this.notify();
  }
  dismissPreview() { this.preview = null; this.notify(); }
  /** Step 2: send exactly the previewed payload. */
  async confirmSend() {
    const p = this.preview; if (!p) return;
    this.preview = null; this.inline = null;
    try {
      const { requestId } = await call('ai.send.v1', { id: p.id });
      this.current = { requestId, action: p.action, text: '', status: 'Waiting for the model…', done: null, provider: p.provider.label, model: p.provider.model, ...(p.inline ? { inline: p.inline } : {}) };
    } catch (e) { this.onError(e); }
    this.notify();
  }
  cancel() { if (this.current && !this.current.done) void call('ai.cancel.v1', { requestId: this.current.requestId }).catch(this.onError); }
  async clearHistory() { try { await call('ai.clearHistory.v1', {}); this.history = []; this.current = null; } catch (e) { this.onError(e); } this.notify(); }
  decide(id: number, d: 'accept' | 'reject') { if (!this.inline) return; const m = new Map(this.inline.decision); m.set(id, d); this.inline = { ...this.inline, decision: m }; this.notify(); }
  /** Merged text with only accepted hunks; undecided hunks count as rejected. */
  merged() { const i = this.inline!; return applyHunks(i.original, i.hunks, new Set([...i.decision].filter(([, v]) => v === 'accept').map(([k]) => k))); }
  closeInline() { this.inline = null; this.notify(); }
}
