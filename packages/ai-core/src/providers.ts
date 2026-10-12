import type { ChatMessage } from './prompt';

/** Provider abstraction, version 1. Adapters run in NOVA's main process only. */
export const PROVIDER_API_VERSION = 1;
export type ProviderKind = 'ollama' | 'openai';
export interface ProviderConfig { id: string; kind: ProviderKind; label: string; baseUrl: string; model: string; temperature?: number; seed?: number }
export interface ChatRequest { messages: ChatMessage[]; signal: AbortSignal; onToken(t: string): void }
export interface ChatResult { text: string; model: string; promptTokens?: number; completionTokens?: number }
export interface RequestLog { url: string; method: string; headers: Record<string, string>; body: unknown }
export interface ProviderDeps {
  fetch: typeof fetch;
  apiKey?: string | null;
  /** Called with exactly what is about to be sent (auth header value masked). */
  onRequest?(r: RequestLog): void;
}
export interface AiProvider {
  readonly apiVersion: 1;
  readonly config: ProviderConfig;
  listModels(signal: AbortSignal): Promise<string[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) { super(message); }
}

export function validateBaseUrl(u: string): string {
  let url: URL; try { url = new URL(u); } catch { throw new ProviderError(`Invalid base URL: ${u}`, false); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProviderError('Base URL must be http(s)', false);
  if (url.username || url.password) throw new ProviderError('Put credentials in the API key field, not in the URL', false);
  return url.toString().replace(/\/+$/, '');
}
const isLocal = (u: string) => { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'; };
export const isLocalProvider = (c: ProviderConfig) => isLocal(c.baseUrl);

async function post(deps: ProviderDeps, url: string, body: unknown, signal: AbortSignal, auth: boolean) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/x-ndjson, text/event-stream, application/json' };
  if (auth && deps.apiKey) headers.authorization = `Bearer ${deps.apiKey}`;
  deps.onRequest?.({ url, method: 'POST', headers: { ...headers, ...(headers.authorization ? { authorization: 'Bearer ***' } : {}) }, body });
  let res: Response;
  try { res = await deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (signal.aborted) throw e; throw new ProviderError(`Cannot reach ${new URL(url).host}: ${e instanceof Error ? e.message : e}`, true); }
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 500);
    throw new ProviderError(`${res.status} ${res.statusText}${t ? `: ${t}` : ''}`, res.status === 429 || res.status >= 500, res.status);
  }
  if (!res.body) throw new ProviderError('Empty response body', true);
  return res.body;
}
async function* lines(body: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k).replace(/\r$/, ''); buf = buf.slice(k + 1); if (l) yield l; }
  }
  if (buf.trim()) yield buf.trim();
}

export class OllamaProvider implements AiProvider {
  readonly apiVersion = 1 as const;
  constructor(readonly config: ProviderConfig, private deps: ProviderDeps) { config.baseUrl = validateBaseUrl(config.baseUrl); }
  async listModels(signal: AbortSignal) {
    const r = await this.deps.fetch(`${this.config.baseUrl}/api/tags`, { signal });
    if (!r.ok) throw new ProviderError(`${r.status} ${r.statusText}`, r.status >= 500);
    return ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    const options: Record<string, number> = {};
    if (this.config.temperature !== undefined) options.temperature = this.config.temperature;
    if (this.config.seed !== undefined) options.seed = this.config.seed;
    const body = await post(this.deps, `${this.config.baseUrl}/api/chat`, { model: this.config.model, messages: req.messages, stream: true, options }, req.signal, true);
    let text = ''; let res: ChatResult = { text: '', model: this.config.model };
    for await (const l of lines(body)) {
      let j: { message?: { content?: string }; done?: boolean; error?: string; model?: string; prompt_eval_count?: number; eval_count?: number };
      try { j = JSON.parse(l); } catch { continue; }
      if (j.error) throw new ProviderError(j.error, false);
      const t = j.message?.content ?? ''; if (t) { text += t; req.onToken(t); }
      if (j.done) res = { text, model: j.model ?? this.config.model, promptTokens: j.prompt_eval_count, completionTokens: j.eval_count };
    }
    return { ...res, text };
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly apiVersion = 1 as const;
  constructor(readonly config: ProviderConfig, private deps: ProviderDeps) { config.baseUrl = validateBaseUrl(config.baseUrl); }
  async listModels(signal: AbortSignal) {
    const r = await this.deps.fetch(`${this.config.baseUrl}/models`, { signal, headers: this.deps.apiKey ? { authorization: `Bearer ${this.deps.apiKey}` } : {} });
    if (!r.ok) throw new ProviderError(`${r.status} ${r.statusText}`, r.status >= 500);
    return ((await r.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    const extra: Record<string, number> = {};
    if (this.config.temperature !== undefined) extra.temperature = this.config.temperature;
    if (this.config.seed !== undefined) extra.seed = this.config.seed;
    const body = await post(this.deps, `${this.config.baseUrl}/chat/completions`, { model: this.config.model, messages: req.messages, stream: true, ...extra }, req.signal, true);
    let text = '';
    for await (const l of lines(body)) {
      if (!l.startsWith('data:')) continue;
      const d = l.slice(5).trim(); if (d === '[DONE]') break;
      let j: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new ProviderError(j.error.message ?? 'provider error', false);
      const t = j.choices?.[0]?.delta?.content ?? ''; if (t) { text += t; req.onToken(t); }
    }
    return { text, model: this.config.model };
  }
}

export function createProvider(c: ProviderConfig, deps: ProviderDeps): AiProvider {
  return c.kind === 'ollama' ? new OllamaProvider({ ...c }, deps) : new OpenAiCompatibleProvider({ ...c }, deps);
}

/**
 * Runs a chat with an overall timeout, an idle (no data) timeout and retries.
 * Retries only happen for retryable errors *before the first token* — a partially streamed answer is never replayed.
 */
export async function chatWithRetry(p: AiProvider, req: { messages: ChatMessage[]; signal: AbortSignal; onToken(t: string): void; onRetry?(attempt: number, err: Error): void },
  opts: { timeoutMs: number; idleTimeoutMs: number; retries: number; backoffMs?: number }): Promise<ChatResult> {
  let attempt = 0;
  for (;;) {
    const ac = new AbortController(); let why: string | null = null;
    const abort = (w: string) => { why = w; ac.abort(); };
    const onOuter = () => abort('cancelled'); req.signal.addEventListener('abort', onOuter);
    if (req.signal.aborted) abort('cancelled');
    const total = setTimeout(() => abort(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
    let idle = setTimeout(() => abort(`no response for ${opts.idleTimeoutMs} ms`), opts.idleTimeoutMs);
    let got = false;
    try {
      return await p.chat({ messages: req.messages, signal: ac.signal, onToken: (t) => { got = true; clearTimeout(idle); idle = setTimeout(() => abort(`stalled for ${opts.idleTimeoutMs} ms`), opts.idleTimeoutMs); req.onToken(t); } });
    } catch (e) {
      const err = why ? new ProviderError(why === 'cancelled' ? 'Cancelled' : `Request ${why}`, why !== 'cancelled' && !got) : e instanceof Error ? e : new Error(String(e));
      if (why === 'cancelled') throw Object.assign(err, { cancelled: true });
      const retryable = err instanceof ProviderError && err.retryable && !got;
      if (!retryable || attempt >= opts.retries) throw err;
      attempt++; req.onRetry?.(attempt, err);
      await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 500) * 2 ** (attempt - 1)));
      if (req.signal.aborted) throw Object.assign(new ProviderError('Cancelled', false), { cancelled: true });
    } finally { clearTimeout(total); clearTimeout(idle); req.signal.removeEventListener('abort', onOuter); }
  }
}
