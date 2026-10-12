import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildMessages, chatWithRetry, classifyFile, createProvider, extractCode, ignoreMatcher, isLocalProvider, proposedCommands, redactSecrets, sensitiveReason,
  type AiAction, type ChatMessage, type ProviderConfig, type RequestLog, type UntrustedPart,
} from '@nova/ai-core';
import { atomicWrite } from '../atomicWrite';
import { readFileHead } from '../workspaceFs';
import { MAX_CONTEXT_FILE_BYTES } from '@nova/ai-core';
import type { KeyStore } from './keys';
import type { AiHistory } from './history';

export const ProviderCfg = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), kind: z.enum(['ollama', 'openai']), label: z.string().min(1).max(60),
  baseUrl: z.string().max(500), model: z.string().max(200), temperature: z.number().min(0).max(2).optional(), seed: z.number().int().optional(),
});
export const AiConfig = z.object({
  enabled: z.boolean().default(false),
  activeProvider: z.string().default('ollama'),
  providers: z.array(ProviderCfg).max(20).default([
    { id: 'ollama', kind: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:0.5b', temperature: 0.2 },
    { id: 'openai', kind: 'openai', label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: '' },
  ]),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  idleTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  retries: z.number().int().min(0).max(5).default(2),
  includeHistory: z.boolean().default(true),
});
export type AiConfig = z.infer<typeof AiConfig>;

export interface PrepareRequest {
  action: AiAction; prompt?: string;
  files?: string[];
  selection?: { rel: string; text: string; startLine: number; languageId?: string };
  diagnostic?: { rel: string; line: number; col: number; severity: string; message: string; source: string };
  terminal?: string;
}
export interface Preview {
  id: string; action: AiAction;
  provider: { id: string; label: string; kind: string; baseUrl: string; model: string; local: boolean };
  messages: ChatMessage[];
  included: { source: string; chars: number; redactions: { kind: string; count: number }[] }[];
  excluded: { rel: string; reason: string; detail: string }[];
}
interface Deps {
  dir: string; keys: KeyStore; history: AiHistory;
  workspace(): { root: string; trusted: boolean } | null;
  fetch: typeof fetch;
  emit(name: string, payload: unknown): void;
  requestLog?: string | null; // NOVA_AI_REQUEST_LOG: append exactly what is sent (key masked) — for audits and tests
}
const MAX_PART = 60_000;

/** All AI network traffic happens here, in the main process. */
export class AiService {
  private pending = new Map<string, { preview: Preview; root: string; userText: string; at: number }>();
  private running = new Map<string, AbortController>();
  private cfg: AiConfig | null = null;
  constructor(private d: Deps) {}
  private get file() { return path.join(this.d.dir, 'ai.json'); }

  async config(): Promise<AiConfig> {
    if (!this.cfg) { let raw: unknown = {}; try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { /* defaults */ } const r = AiConfig.safeParse(raw); this.cfg = r.success ? r.data : AiConfig.parse({}); }
    return this.cfg;
  }
  async publicConfig() {
    const c = await this.config();
    return { ...c, providers: await Promise.all(c.providers.map(async (p) => ({ ...p, hasKey: await this.d.keys.has(p.id), local: safeLocal(p) }))), keychain: this.d.keys.status() };
  }
  async setConfig(patch: Partial<AiConfig>) {
    const next = AiConfig.parse({ ...(await this.config()), ...patch });
    for (const p of next.providers) createProvider(p, { fetch: this.d.fetch }); // validates URLs
    if (!next.providers.some((p) => p.id === next.activeProvider)) throw new Error('Unknown active provider');
    this.cfg = next; await fs.mkdir(this.d.dir, { recursive: true }); await atomicWrite(this.file, JSON.stringify(next, null, 2));
    if (!next.enabled) this.cancelAll();
    return this.publicConfig();
  }
  async setKey(id: string, key: string | null) { await this.d.keys.set(id, key && key.trim() ? key.trim() : null); }
  private async enabled() { const c = await this.config(); if (!c.enabled) throw new Error('NOVA AI is turned off. Enable it in the AI panel first.'); return c; }
  private provider(c: AiConfig, onRequest?: (r: RequestLog) => void, apiKey?: string | null) {
    const p = c.providers.find((x) => x.id === c.activeProvider)!;
    if (!p.model) throw new Error(`Choose a model for ${p.label} first`);
    return createProvider(p as ProviderConfig, { fetch: this.d.fetch, apiKey, onRequest });
  }
  async listModels(id: string) {
    const c = await this.enabled(); const p = c.providers.find((x) => x.id === id); if (!p) throw new Error('Unknown provider');
    return createProvider(p as ProviderConfig, { fetch: this.d.fetch, apiKey: await this.d.keys.get(id) }).listModels(AbortSignal.timeout(10_000));
  }

  /** Builds exactly what would be sent, applying exclusion and redaction. Nothing leaves the machine here. */
  async prepare(req: PrepareRequest): Promise<Preview> {
    const c = await this.enabled();
    const ws = this.d.workspace();
    const pc = c.providers.find((x) => x.id === c.activeProvider)!;
    const parts: UntrustedPart[] = []; const included: Preview['included'] = []; const excluded: Preview['excluded'] = [];
    const ignored = ws ? ignoreMatcher(await fs.readFile(path.join(ws.root, '.gitignore'), 'utf8').catch(() => null), await fs.readFile(path.join(ws.root, '.novaaiignore'), 'utf8').then((t) => t.split('\n')).catch(() => [])) : () => false;
    const add = (source: string, text: string) => {
      const r = redactSecrets(text.length > MAX_PART ? `${text.slice(0, MAX_PART)}\n[… truncated by NOVA …]` : text);
      parts.push({ source, text: r.text }); included.push({ source, chars: r.text.length, redactions: r.redactions });
    };
    for (const rel of [...new Set(req.files ?? [])].slice(0, 20)) {
      if (!ws) break;
      const pre = sensitiveReason(rel); if (pre) { excluded.push({ rel, reason: 'sensitive', detail: pre }); continue; } // decided before reading
      let bytes: Uint8Array; let size: number;
      try { ({ bytes, size } = await readFileHead(ws.root, rel, MAX_CONTEXT_FILE_BYTES + 1)); } catch (e) { excluded.push({ rel, reason: 'unreadable', detail: e instanceof Error ? e.message : String(e) }); continue; }
      if (size > MAX_CONTEXT_FILE_BYTES) { excluded.push({ rel, reason: 'oversized', detail: `${size} bytes > ${MAX_CONTEXT_FILE_BYTES}` }); continue; }
      const k = classifyFile(rel, bytes, ignored); if (!k.ok) { excluded.push({ rel, reason: k.reason, detail: k.detail }); continue; }
      add(`file: ${rel}`, new TextDecoder().decode(bytes));
    }
    if (req.selection) {
      const s = req.selection; const k = classifyFile(s.rel, null, ignored);
      if (!k.ok) excluded.push({ rel: s.rel, reason: k.reason, detail: `${k.detail} (selection not sent)` });
      else add(`selection: ${s.rel} from line ${s.startLine}${s.languageId ? ` (${s.languageId})` : ''}`, s.text);
    }
    if (req.diagnostic) { const g = req.diagnostic; add(`diagnostic: ${g.rel}:${g.line}:${g.col} [${g.source}]`, `${g.severity}: ${g.message}`); }
    if (req.terminal) add('terminal output', req.terminal.slice(-20_000));
    if (req.action === 'chat' && !req.prompt?.trim()) throw new Error('Type a message first');
    const history = c.includeHistory && req.action === 'chat' && ws ? (await this.d.history.list(ws.root)).filter((h) => !h.error && h.action === 'chat').slice(-10).map((h) => ({ role: h.role, content: h.content })) : [];
    const messages = buildMessages(req.action, { prompt: req.prompt ?? '', parts, history });
    const preview: Preview = { id: crypto.randomUUID(), action: req.action, provider: { id: pc.id, label: pc.label, kind: pc.kind, baseUrl: pc.baseUrl, model: pc.model, local: safeLocal(pc) }, messages, included, excluded };
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(preview.id, { preview, root: ws?.root ?? '', userText: req.prompt?.trim() || `[${req.action}] ${included.map((i) => i.source).join(', ')}`, at: Date.now() });
    return preview;
  }

  /** Sends a previewed request unchanged. Streams ai.token.v1 events and finishes with ai.done.v1. */
  async send(previewId: string) {
    const c = await this.enabled();
    const p = this.pending.get(previewId); if (!p) throw new Error('Preview expired; prepare the request again');
    this.pending.delete(previewId);
    if (p.preview.provider.id !== c.activeProvider) throw new Error('Provider changed since the preview; prepare again');
    const requestId = previewId; const ac = new AbortController(); this.running.set(requestId, ac);
    const prov = this.provider(c, (r) => void this.logRequest(r), await this.d.keys.get(c.activeProvider));
    const meta = { provider: p.preview.provider.label, model: p.preview.provider.model, action: p.preview.action };
    void (async () => {
      let text = '';
      try {
        const r = await chatWithRetry(prov, { messages: p.preview.messages, signal: ac.signal, onToken: (t) => { text += t; this.d.emit('ai.token.v1', { requestId, token: t }); },
          onRetry: (attempt, err) => this.d.emit('ai.status.v1', { requestId, message: `Retrying (${attempt}/${c.retries}) after: ${err.message}` }) },
        { timeoutMs: c.timeoutMs, idleTimeoutMs: c.idleTimeoutMs, retries: c.retries });
        text = r.text;
        if (p.root) await this.d.history.append(p.root, this.entry('user', p.userText, meta), this.entry('assistant', text, meta)).catch(() => {});
        this.d.emit('ai.done.v1', { requestId, text, error: null, cancelled: false, code: extractCode(text), commands: proposedCommands(text), model: r.model, usage: { prompt: r.promptTokens ?? null, completion: r.completionTokens ?? null } });
      } catch (e) {
        const cancelled = !!(e as { cancelled?: boolean }).cancelled; const msg = e instanceof Error ? e.message : String(e);
        if (p.root) await this.d.history.append(p.root, this.entry('user', p.userText, meta), this.entry('assistant', text + (cancelled ? '\n[cancelled]' : ''), meta, cancelled ? 'cancelled' : msg)).catch(() => {});
        this.d.emit('ai.done.v1', { requestId, text, error: cancelled ? null : msg, cancelled, code: null, commands: [], model: meta.model, usage: null });
      } finally { this.running.delete(requestId); }
    })();
    return { requestId };
  }
  cancel(requestId: string) { this.running.get(requestId)?.abort(); }
  cancelAll() { for (const a of this.running.values()) a.abort(); }
  async history() { const ws = this.d.workspace(); return ws ? this.d.history.list(ws.root) : []; }
  async clearHistory() { const ws = this.d.workspace(); if (ws) await this.d.history.clear(ws.root); }
  private entry(role: 'user' | 'assistant', content: string, m: { provider: string; model: string; action: string }, error?: string) {
    return { id: crypto.randomUUID(), at: new Date().toISOString(), role, content, ...m, ...(error ? { error } : {}) };
  }
  private async logRequest(r: RequestLog) {
    if (!this.d.requestLog) return;
    await fs.appendFile(this.d.requestLog, `${JSON.stringify({ at: new Date().toISOString(), ...r })}\n`).catch(() => {});
  }
}
function safeLocal(p: { baseUrl: string; kind: string; label: string; id: string; model: string }) { try { return isLocalProvider(p as ProviderConfig); } catch { return false; } }
