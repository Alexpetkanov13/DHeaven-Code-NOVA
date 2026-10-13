import { spawn } from 'node:child_process';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { DapConnection } from './connection';
import type { AdapterFactory } from './manager';
import { killTree } from '../proc';

/**
 * Splits a program-arguments string the way a POSIX shell would for plain words: whitespace separates, "double" and
 * 'single' quotes group, backslash escapes inside double quotes and outside quotes. No variables, globs or operators.
 */
export function splitArgs(s: string): string[] {
  const out: string[] = []; let cur = ''; let has = false; let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (c === '\\' && i + 1 < s.length && (q === null || /["\\$`]/.test(s[i + 1]!))) { cur += s[++i]; has = true; continue; }
    if (q === '"') { if (c === '"') q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (q) throw new Error(`Unclosed ${q} quote in program arguments`);
  if (has || cur) out.push(cur);
  return out;
}

/** `python -c` probe: debugpy's version, or a clear error naming the interpreter and the install command. */
export function probeDebugpy(python: string, cwd: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(python, ['-c', 'import debugpy; print(debugpy.__version__)'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    p.stderr!.on('data', (b: Buffer) => { err += b.toString(); });
    const t = setTimeout(() => { p.kill(); reject(new Error(`${python} did not answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`Cannot run ${python}: ${e.message}. Install Python or create a .venv in the workspace.`)); });
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0 && out.trim()) resolve(out.trim());
      else if (/No module named ['"]?debugpy/.test(err)) reject(new Error(`debugpy is not installed for ${python}. Install it with: ${python} -m pip install debugpy`));
      else reject(new Error(`${python} -c "import debugpy" failed (exit ${code}): ${err.trim().slice(0, 500)}`));
    });
  });
}

export interface PythonDeps { pythonFor(root: string): Promise<{ command: string; source: string }> }

/**
 * debugpy (installed by the user with pip, like the language servers: NOVA never downloads it). The adapter runs as
 * `<python> -m debugpy.adapter` over stdio; it starts the debuggee itself with the same interpreter. Killing the adapter's
 * process tree on disconnect also ends a debuggee that ignored `disconnect`.
 */
export function pythonAdapter(d: PythonDeps): AdapterFactory {
  return async (cfg, { root, log, signal }) => {
    const py = await d.pythonFor(root);
    const version = await probeDebugpy(py.command, root);
    log(`Python: ${py.command} (${py.source}) · debugpy ${version}`);
    if (signal.aborted) throw new Error('Cancelled');
    let args: Record<string, unknown>;
    if (cfg.request === 'launch') {
      const program = cfg.program?.trim(); const module = cfg.module?.trim();
      if (!program === !module) throw new Error('Set either a program (script path) or a module, not both.');
      args = {
        type: 'python', name: cfg.name, request: 'launch',
        ...(program ? { program: path.resolve(root, program) } : { module }),
        args: splitArgs(cfg.args ?? ''), cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root, env: cfg.env ?? {},
        python: [py.command], console: 'internalConsole', redirectOutput: true, justMyCode: cfg.justMyCode ?? true, showReturnValue: true,
      };
    } else {
      args = { type: 'python', name: cfg.name, request: 'attach', connect: { host: cfg.hostName || '127.0.0.1', port: cfg.port ?? 5678 }, justMyCode: cfg.justMyCode ?? true };
    }
    const p = spawn(py.command, ['-m', 'debugpy.adapter'], { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stderr!.on('data', (b: Buffer) => { for (const l of b.toString('utf8').split(/\r?\n/)) if (l.trim()) log(`[debugpy] ${l}`); });
    const failed = await new Promise<Error | null>((resolve) => { p.once('spawn', () => resolve(null)); p.once('error', (e) => resolve(e)); });
    if (failed) throw new Error(`Cannot start debugpy adapter: ${failed.message}`);
    const stream = Duplex.from({ readable: p.stdout!, writable: p.stdin! }) as Duplex & NodeJS.ReadWriteStream;
    p.on('exit', () => stream.destroy());
    const conn = new DapConnection(stream, (command) => { throw new Error(`reverse request ${command} not supported`); });
    conn.on('close', () => { if (p.pid && p.exitCode === null) killTree(p.pid); });
    return { conn, args };
  };
}
