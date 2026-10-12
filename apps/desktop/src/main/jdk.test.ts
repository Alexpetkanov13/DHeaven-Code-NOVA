import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { discoverJdks, probeJdk } from './jdk';

describe('jdk discovery', () => {
  it('reads release file and finds custom dirs', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-jdk-'));
    await fs.mkdir(path.join(d, 'bin'));
    await fs.writeFile(path.join(d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '');
    await fs.writeFile(path.join(d, 'release'), 'JAVA_VERSION="21.0.5"\n');
    expect(await probeJdk(d, 'x')).toMatchObject({ major: 21, version: '21.0.5' });
    expect((await discoverJdks([d])).some((j) => j.home === path.resolve(d) && j.source === 'custom')).toBe(true);
    await fs.writeFile(path.join(d, 'release'), 'JAVA_VERSION="1.8.0_392"\n');
    expect((await probeJdk(d, 'x'))!.major).toBe(8);
  });
});
