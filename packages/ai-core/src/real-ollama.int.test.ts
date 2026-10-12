import { describe, expect, it } from 'vitest';
import { chatWithRetry, createProvider } from './index';

/** Integration with a REAL local model (Ollama). Skipped when it isn't running. */
const URL_ = process.env.NOVA_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.NOVA_OLLAMA_MODEL ?? 'qwen2.5-coder:0.5b';
const up = await fetch(`${URL_}/api/tags`).then((r) => r.json() as Promise<{ models: { name: string }[] }>).then((j) => j.models.some((m) => m.name === MODEL)).catch(() => false);

describe.skipIf(!up)(`real model ${MODEL} via Ollama`, () => {
  for (const kind of ['ollama', 'openai'] as const) {
    it(`${kind} adapter streams a real completion`, async () => {
      const p = createProvider({ id: kind, kind, label: kind, baseUrl: kind === 'ollama' ? URL_ : `${URL_}/v1`, model: MODEL, temperature: 0, seed: 1 }, { fetch });
      const toks: string[] = [];
      const r = await chatWithRetry(p, { messages: [{ role: 'user', content: 'Reply with the single word: pong' }], signal: new AbortController().signal, onToken: (t) => toks.push(t) }, { timeoutMs: 60_000, idleTimeoutMs: 30_000, retries: 0 });
      expect(r.text.toLowerCase()).toContain('pong');
      expect(toks.length).toBeGreaterThanOrEqual(1);
      expect(toks.join('')).toBe(r.text);
    }, 90_000);
  }
  it('lists models', async () => {
    expect(await createProvider({ id: 'o', kind: 'ollama', label: 'o', baseUrl: URL_, model: MODEL }, { fetch }).listModels(AbortSignal.timeout(5000))).toContain(MODEL);
    expect(await createProvider({ id: 'x', kind: 'openai', label: 'x', baseUrl: `${URL_}/v1`, model: MODEL }, { fetch }).listModels(AbortSignal.timeout(5000))).toContain(MODEL);
  });
});
