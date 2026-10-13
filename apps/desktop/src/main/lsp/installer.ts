import { rmRetry } from '../fsRetry';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
export interface Installable {
  id: string; name: string; version: string; installDir(serversDir: string): string;
  download: { url: string; sha256: string; kind: 'tar.gz' | 'zip' | 'jar' };
}

function run(cmd: string, args: string[], cwd: string) {
  return new Promise<void>((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore', windowsHide: true });
    p.on('error', rej); p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
  });
}

/** Downloads a pinned server archive, verifies SHA-256, extracts it. Only called after explicit user consent. */
export async function installServer(def: Installable, serversDir: string, fetchFn: typeof fetch, onProgress: (msg: string) => void) {
  const dest = def.installDir(serversDir);
  const tmp = path.join(serversDir, `.download-${def.id}-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true });
  const file = path.join(tmp, `archive.${def.download.kind}`);
  try {
    onProgress(`Downloading ${def.download.url}`);
    const res = await fetchFn(def.download.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const h = crypto.createHash('sha256');
    const ws = createWriteStream(file);
    let n = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      h.update(chunk); ws.write(chunk); n += chunk.length;
      if (n > 600 * 1024 * 1024) throw new Error('download too large');
    }
    await new Promise<void>((r, j) => ws.end((e?: Error | null) => (e ? j(e) : r())));
    const digest = h.digest('hex');
    if (digest !== def.download.sha256) throw new Error(`SHA-256 mismatch: expected ${def.download.sha256}, got ${digest}`);
    onProgress(`Verified SHA-256 (${(n / 1e6).toFixed(1)} MB). Extracting…`);
    await rmRetry(dest);
    await fs.mkdir(dest, { recursive: true });
    if (def.download.kind === 'jar') await fs.copyFile(file, path.join(dest, path.basename(new URL(def.download.url).pathname)));
    else if (def.download.kind === 'tar.gz') await run('tar', ['-xzf', file, '-C', dest], tmp);
    else if (process.platform === 'win32') await run('tar', ['-xf', file, '-C', dest], tmp);
    else await run('unzip', ['-q', '-o', file, '-d', dest], tmp);
    onProgress(`Installed ${def.name} ${def.version}`);
  } finally {
    await rmRetry(tmp);
  }
}
