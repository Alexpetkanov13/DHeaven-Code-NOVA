import { describe, expect, it } from 'vitest';
import { fileUri } from './lsp/uri';
import { parseProblems, parseTasks } from './gradle';

describe('gradle parsing', () => {
  it('parses tasks', () => {
    const out = 'Build tasks\n-----------\nassemble - Assembles the outputs.\nbuild - Assembles and tests this project.\n\nApplication tasks\n-----------------\nrun - Runs this project as a JVM application\n';
    expect(parseTasks(out)).toEqual([
      { name: 'assemble', group: 'Build', description: 'Assembles the outputs.' },
      { name: 'build', group: 'Build', description: 'Assembles and tests this project.' },
      { name: 'run', group: 'Application', description: 'Runs this project as a JVM application' },
    ]);
  });
  it('parses javac and kotlinc problems', () => {
    const p = parseProblems('/w/src/main/java/A.java:12: error: cannot find symbol\n' +
      'e: file:///w/src/main/kotlin/B.kt:3:9 Unresolved reference \'foo\'.\nw: /w/C.kt: (4, 2): Unused variable\nnoise');
    expect(p.map((x) => [x.source, x.line, x.col, x.severity])).toEqual([['javac', 12, 1, 'error'], ['kotlinc', 3, 9, 'error'], ['kotlinc', 4, 2, 'warning']]);
    expect(p[1]!.uri).toBe(fileUri('/w/src/main/kotlin/B.kt'));
  });
  it('dedupes the indented repeat Gradle prints under "What went wrong"', () => {
    const f = process.platform === 'win32' ? 'C:\\w\\A.java' : '/w/A.java';
    const out = `${f}:5: error: incompatible types\n* What went wrong:\n  ${f}:5: error: incompatible types\n`;
    const ps = parseProblems(out);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ uri: fileUri(f), line: 5, source: 'javac' });
  });
});

describe('stopGradleDaemons', () => {
  it.skipIf(process.platform === 'win32')('runs `gradlew --stop` once per project NOVA used, then forgets it', async () => {
    const { default: fsp } = await import('node:fs/promises');
    const os = await import('node:os');
    const pth = await import('node:path');
    const { gradleUsed, runGradle, stopGradleDaemons } = await import('./gradle');
    const root = await fsp.mkdtemp(pth.join(os.tmpdir(), 'nova-gstop-'));
    const log = pth.join(root, 'calls.txt');
    await fsp.writeFile(pth.join(root, 'gradlew'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
    await new Promise<void>((r) => runGradle(root, { isGradle: true, wrapper: true, buildFile: null }, ['help'], process.env, () => {}, () => r()));
    expect(gradleUsed.has(root)).toBe(true);
    expect(await stopGradleDaemons(5000)).toEqual([root]);
    expect((await fsp.readFile(log, 'utf8')).trim().split('\n')).toEqual(['help --console=plain', '--stop --console=plain -q']);
    expect(gradleUsed.size).toBe(0);
    expect(await stopGradleDaemons(5000)).toEqual([]);
  });
});
