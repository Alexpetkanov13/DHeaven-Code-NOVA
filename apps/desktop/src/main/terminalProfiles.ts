import fs from 'node:fs';
import path from 'node:path';

export interface TerminalProfile { id: string; name: string; path: string }

function onPath(exe: string, env: NodeJS.ProcessEnv): string | null {
  for (const d of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/**
 * Shells available on this machine. The renderer only ever sends a profile id; the executable path is resolved here,
 * so a compromised renderer cannot spawn arbitrary programs through the terminal.
 */
export function detectProfiles(platform = process.platform, env = process.env, exists = (p: string) => fs.existsSync(p)): TerminalProfile[] {
  const out: TerminalProfile[] = [];
  const add = (id: string, name: string, p: string | null) => { if (p && !out.some((x) => x.id === id)) out.push({ id, name, path: p }); };
  if (platform === 'win32') {
    add('pwsh', 'PowerShell 7', onPath('pwsh.exe', env));
    const sysRoot = env.SystemRoot ?? 'C:\\Windows';
    const winPs = path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    add('powershell', 'Windows PowerShell', exists(winPs) ? winPs : onPath('powershell.exe', env));
    const cmd = env.ComSpec ?? env.COMSPEC ?? path.win32.join(sysRoot, 'System32', 'cmd.exe');
    add('cmd', 'Command Prompt', exists(cmd) ? cmd : onPath('cmd.exe', env));
    const gitBash = [env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => p && exists(p));
    add('bash', 'Git Bash', gitBash ?? null);
  } else {
    if (env.SHELL && exists(env.SHELL)) add(path.basename(env.SHELL), `${path.basename(env.SHELL)} (default)`, env.SHELL);
    for (const s of ['bash', 'zsh', 'fish', 'sh']) add(s, s, ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((d) => `${d}/${s}`).find(exists) ?? null);
  }
  return out;
}

/** Profile to use: the requested id, else the saved one, else the platform default (first detected). */
export function pickProfile(profiles: TerminalProfile[], requested?: string | null, saved?: string | null): TerminalProfile | null {
  return profiles.find((p) => p.id === requested) ?? profiles.find((p) => p.id === saved) ?? profiles[0] ?? null;
}
