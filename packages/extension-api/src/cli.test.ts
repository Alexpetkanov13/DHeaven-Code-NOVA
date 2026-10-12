import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readArchive } from './archive';

const repo = path.resolve(__dirname, '../../..');
const cli = path.resolve(__dirname, '../bin/nova-ext.cjs');
beforeAll(() => { execFileSync(process.execPath, [path.resolve(__dirname, '../build.mjs')], { cwd: path.resolve(__dirname, '..') }); });

describe('nova-ext CLI', () => {
  it('validates and packs every example extension; output passes readArchive', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-cli-'));
    for (const ex of ['hello-world', 'custom-theme', 'sample-language']) {
      const dir = path.join(repo, 'extensions/examples', ex);
      expect(execFileSync(process.execPath, [cli, 'validate', dir], { encoding: 'utf8' })).toMatch(/^OK dheaven\./m);
      const file = path.join(out, `${ex}.novaext`);
      expect(execFileSync(process.execPath, [cli, 'pack', dir, '-o', file], { encoding: 'utf8' })).toMatch(/sha256 [0-9a-f]{64}/);
      const r = readArchive(await fs.readFile(file));
      expect((await fs.readFile(`${file}.sha256`, 'utf8')).split(' ')[0]).toBe(r.archiveSha256);
      expect(execFileSync(process.execPath, [cli, 'validate', file], { encoding: 'utf8' })).toContain(r.archiveSha256);
    }
  });
  it('fails with a non-zero exit and a readable error for an invalid manifest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-cli-bad-'));
    await fs.writeFile(path.join(dir, 'nova-extension.json'), JSON.stringify({ manifestVersion: 1, name: 'Bad Name', publisher: 'x', displayName: 'x', version: '1', engines: { nova: '*' } }));
    const r = spawnSync(process.execPath, [cli, 'validate', dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/name: .*lowercase/);
    expect(r.stderr).toMatch(/version: must be semver/);
  });
});
