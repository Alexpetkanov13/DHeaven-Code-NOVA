import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AiService } from './service';
import { KeyStore, type SecretCipher } from './keys';
import { AiHistory } from './history';

const cipher = (backend = 'gnome_libsecret', available = true): SecretCipher => ({
  isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});
let url = ''; let srv: http.Server; const bodies: string[] = []; let delayMs = 0;
beforeAll(async () => {
  srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
    bodies.push(b);
    res.write('{"message":{"content":"Sure. "}}\n');
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    res.end('{"message":{"content":"```sh\\nnpm test\\n```"}}\n{"done":true,"model":"stub"}\n');
  }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

async function setup(c: SecretCipher = cipher()) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-ai-'));
  const root = path.join(tmp, 'ws'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, '.env'), 'DB_PASSWORD=supersecretvalue\n');
  await fs.writeFile(path.join(root, 'app.ts'), 'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123";\nexport const x = 1;\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\n');
  await fs.mkdir(path.join(root, 'build')); await fs.writeFile(path.join(root, 'build/out.js'), 'compiled');
  await fs.writeFile(path.join(root, 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 0, 1]));
  const events: [string, unknown][] = [];
  const log = path.join(tmp, 'req.log');
  const svc = new AiService({ dir: path.join(tmp, 'ud'), keys: new KeyStore(path.join(tmp, 'ud'), c), history: new AiHistory(path.join(tmp, 'ud', 'hist')),
    workspace: () => ({ root, trusted: true }), fetch, emit: (n, p) => events.push([n, p]), requestLog: log });
  return { svc, events, log, tmp, root };
}
const done = (events: [string, unknown][], id: string) => new Promise<Record<string, unknown>>((resolve) => { const t = setInterval(() => { const e = events.find(([n, p]) => n === 'ai.done.v1' && (p as { requestId: string }).requestId === id); if (e) { clearInterval(t); resolve(e[1] as Record<string, unknown>); } }, 10); });

describe('AiService (local HTTP stub server, not a real model)', () => {
  it('is off by default and refuses requests until enabled', async () => {
    const { svc } = await setup();
    expect((await svc.publicConfig()).enabled).toBe(false);
    await expect(svc.prepare({ action: 'chat', prompt: 'hi' })).rejects.toThrow(/turned off/);
  });
  it('preview excludes .env/ignored/binary, redacts secrets, and the sent payload equals the preview', async () => {
    const { svc, events, log } = await setup();
    await svc.setConfig({ enabled: true, providers: [{ id: 'ollama', kind: 'ollama', label: 'Stub', baseUrl: url, model: 'stub' }], activeProvider: 'ollama' });
    const p = await svc.prepare({ action: 'chat', prompt: 'review', files: ['.env', 'app.ts', 'build/out.js', 'logo.png', '../etc/passwd'] });
    expect(p.excluded.map((e) => [e.rel, e.reason])).toEqual([['.env', 'sensitive'], ['build/out.js', 'ignored'], ['logo.png', 'binary'], ['../etc/passwd', 'unreadable']]);
    expect(p.included).toEqual([{ source: 'file: app.ts', chars: expect.any(Number), redactions: [{ kind: 'openai-key', count: 1 }] }]);
    const all = JSON.stringify(p.messages);
    expect(all).not.toContain('supersecretvalue'); expect(all).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123'); expect(all).toContain('<untrusted_data source=\\"file: app.ts\\">');
    const { requestId } = await svc.send(p.id);
    const d = await done(events, requestId);
    expect(d).toMatchObject({ error: null, cancelled: false, text: 'Sure. ```sh\nnpm test\n```', commands: ['npm test'] });
    expect(events.filter(([n]) => n === 'ai.token.v1').length).toBe(2);
    const sent = JSON.parse(bodies.at(-1)!); expect(sent.messages).toEqual(p.messages);
    const logged = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(logged.at(-1).body.messages).toEqual(p.messages); expect(await fs.readFile(log, 'utf8')).not.toContain('supersecretvalue');
    await expect(svc.send(p.id)).rejects.toThrow(/expired/); // one preview, one send
    const h = await svc.history(); expect(h.map((x) => x.role)).toEqual(['user', 'assistant']); expect(h[1]!.provider).toBe('Stub');
    await svc.clearHistory(); expect(await svc.history()).toEqual([]);
  });
  it('a selection from a sensitive file is not sent', async () => {
    const { svc } = await setup();
    await svc.setConfig({ enabled: true, providers: [{ id: 'ollama', kind: 'ollama', label: 'Stub', baseUrl: url, model: 'stub' }] });
    const p = await svc.prepare({ action: 'explainSelection', selection: { rel: 'config/.env.production', text: 'TOKEN=abc', startLine: 1 } });
    expect(p.excluded[0]).toMatchObject({ reason: 'sensitive' }); expect(JSON.stringify(p.messages)).not.toContain('TOKEN=abc');
  });
  it('cancel stops a streaming request', async () => {
    const { svc, events } = await setup(); delayMs = 3000;
    await svc.setConfig({ enabled: true, providers: [{ id: 'ollama', kind: 'ollama', label: 'Stub', baseUrl: url, model: 'stub' }] });
    const { requestId } = await svc.send((await svc.prepare({ action: 'chat', prompt: 'x' })).id);
    await new Promise((r) => setTimeout(r, 200)); svc.cancel(requestId);
    expect(await done(events, requestId)).toMatchObject({ cancelled: true, error: null, text: 'Sure. ' });
    delayMs = 0;
  });
  it('API keys: encrypted at rest, never plaintext, refused without a real OS keyring', async () => {
    const a = await setup();
    await a.svc.setKey('openai', 'sk-live-very-secret-key-000');
    const raw = await fs.readFile(path.join(a.tmp, 'ud', 'ai-keys.json'), 'utf8');
    expect(raw).not.toContain('sk-live-very-secret-key-000');
    expect((await a.svc.publicConfig()).providers.find((p) => p.id === 'openai')!.hasKey).toBe(true);
    expect(JSON.stringify(await a.svc.publicConfig())).not.toContain('sk-live');
    const b = await setup(cipher('basic_text'));
    await expect(b.svc.setKey('openai', 'sk-x-123456')).rejects.toThrow(/securely/);
    const c = await setup(cipher('gnome_libsecret', false));
    await expect(c.svc.setKey('openai', 'sk-x-123456')).rejects.toThrow(/not available/);
  });
  it('validates provider URLs', async () => {
    const { svc } = await setup();
    await expect(svc.setConfig({ providers: [{ id: 'ollama', kind: 'ollama', label: 'x', baseUrl: 'file:///etc', model: 'm' }] })).rejects.toThrow(/http/);
  });
});
