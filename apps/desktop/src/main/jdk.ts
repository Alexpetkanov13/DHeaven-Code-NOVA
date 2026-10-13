import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface Jdk { home: string; version: string; major: number; source: string }

const exe = process.platform === 'win32' ? 'java.exe' : 'java';

/** Reads `<home>/release` (JAVA_VERSION="21.0.5") — no process spawn needed. */
export async function probeJdk(home: string, source: string): Promise<Jdk | null> {
  try {
    await fs.access(path.join(home, 'bin', exe));
    const rel = await fs.readFile(path.join(home, 'release'), 'utf8');
    const m = /JAVA_VERSION="([^"]+)"/.exec(rel);
    if (!m) return null;
    const v = m[1]!;
    const major = Number(v.startsWith('1.') ? v.split('.')[1] : v.split(/[.+-]/)[0]);
    return { home: path.resolve(home), version: v, major, source };
  } catch { return null; }
}

async function children(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir)).map((d) => path.join(dir, d)); } catch { return []; }
}

/** Candidates: JAVA_HOME, java on PATH, and well-known install directories per OS. */
export async function discoverJdks(extra: string[] = []): Promise<Jdk[]> {
  const home = os.homedir();
  const cands: [string, string][] = [];
  if (process.env.JAVA_HOME) cands.push([process.env.JAVA_HOME, 'JAVA_HOME']);
  // JAVA_HOME_21_X64 etc. (CI runners, actions/setup-java)
  for (const [k, v] of Object.entries(process.env)) if (v && /^JAVA_HOME_\d+_(X64|AARCH64|ARM64)$/i.test(k)) cands.push([v, k]);
  for (const p of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!p) continue;
    try { const real = await fs.realpath(path.join(p, exe)); cands.push([path.dirname(path.dirname(real)), 'PATH']); } catch { /* not here */ }
  }
  const dirs: string[] = [path.join(home, '.jdks'), path.join(home, '.sdkman', 'candidates', 'java'), path.join(home, '.gradle', 'jdks'), path.join(home, '.asdf', 'installs', 'java')];
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      dirs.push(path.join(pf, 'Java'), path.join(pf, 'Eclipse Adoptium'), path.join(pf, 'Microsoft'), path.join(pf, 'Zulu'), path.join(pf, 'Amazon Corretto'));
    }
  } else if (process.platform === 'darwin') {
    for (const d of await children('/Library/Java/JavaVirtualMachines')) cands.push([path.join(d, 'Contents', 'Home'), 'system']);
  } else dirs.push('/usr/lib/jvm', '/opt/java', '/usr/java');
  for (const d of dirs) for (const c of await children(d)) cands.push([c, d.startsWith(home) ? d.replace(home, '~') : d]);
  for (const e of extra) cands.push([e, 'custom']);
  const seen = new Set<string>(); const out: Jdk[] = [];
  for (const [h, src] of cands) {
    const j = await probeJdk(h, src);
    if (j && !seen.has(j.home)) { seen.add(j.home); out.push(j); }
  }
  return out.sort((a, b) => b.major - a.major);
}
