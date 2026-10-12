import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installServer } from './installer';

const bytes = Buffer.from('fake jar bytes');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const fetchOk = (async () => new Response(bytes)) as unknown as typeof fetch;
const def = (sha256: string) => ({ id: 'x', name: 'X', version: '1', installDir: (d: string) => path.join(d, 'x', '1'), download: { url: 'https://example.invalid/a/x-1.jar', sha256, kind: 'jar' as const } });

describe('installer', () => {
  it('installs a jar whose SHA-256 matches the pin', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-inst-'));
    const msgs: string[] = [];
    await installServer(def(sha), dir, fetchOk, (m) => msgs.push(m));
    expect(await fs.readFile(path.join(dir, 'x', '1', 'x-1.jar'))).toEqual(bytes);
    expect(msgs.join('\n')).toContain('Verified SHA-256');
  });
  it('refuses a download whose SHA-256 does not match, leaving nothing installed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-inst-'));
    await expect(installServer(def('0'.repeat(64)), dir, fetchOk, () => {})).rejects.toThrow('SHA-256 mismatch');
    await expect(fs.access(path.join(dir, 'x', '1', 'x-1.jar'))).rejects.toThrow();
    expect((await fs.readdir(dir)).filter((f) => f.startsWith('.download'))).toEqual([]);
  });
});
