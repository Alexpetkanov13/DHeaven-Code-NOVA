import { spawn } from 'node:child_process';
import path from 'node:path';
import { DapConnection } from './connection';
import type { AdapterFactory } from './manager';
import { splitArgs } from './python';
import { killTree } from '../proc';

export const JS_DEBUG_SETUP = 'Node.js debugging uses Microsoft\'s js-debug (MIT). Download js-debug-dap-v<version>.tar.gz from https://github.com/microsoft/vscode-js-debug/releases, extract it, then press "Choose js-debug…" in Run and Debug and pick js-debug/src/dapDebugServer.js. NOVA does not download it.';

export interface NodeDeps {
  /** The user's `node` (PATH or extra dirs); also runs the debuggee. */
  node(): Promise<string | null>;
  /** dapDebugServer.js: the path the user chose, else <serversDir>/js-debug/src/dapDebugServer.js if present. */
  jsDebug(): Promise<string | null>;
}

/** Starts `node dapDebugServer.js 0 127.0.0.1` and resolves with the port it prints ("Debug server listening at host:port"). */
function startServer(node: string, server: string, log: (s: string) => void, signal: AbortSignal): Promise<{ port: number; kill(): void }> {
  return new Promise((resolve, reject) => {
    const p = spawn(node, [server, '0', '127.0.0.1'], { cwd: path.dirname(server), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { if (p.pid && p.exitCode === null) killTree(p.pid); };
    let out = '';
    const t = setTimeout(() => { kill(); reject(new Error(`js-debug did not start listening within 15 s:\n${out.slice(-500)}`)); }, 15_000);
    signal.addEventListener('abort', () => { clearTimeout(t); kill(); reject(new Error('Cancelled')); }, { once: true });
    p.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /listening at ([^\s:]+|\[[^\]]+\]):(\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve({ port: Number(m[2]), kill }); }
    });
    p.stderr!.on('data', (b: Buffer) => { for (const l of b.toString('utf8').split(/\r?\n/)) if (l.trim()) log(`[js-debug] ${l}`); });
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`Cannot start js-debug with ${node}: ${e.message}`)); });
    p.on('close', (code) => { clearTimeout(t); reject(new Error(`js-debug exited (code ${code}) before listening:\n${out.slice(-500)}`)); });
  });
}

/**
 * Node.js via js-debug's standalone DAP server. Its first session is a launcher: the debuggee arrives as a
 * `startDebugging` reverse request, for which the manager opens a child connection (openChild) to the same server.
 */
export function nodeAdapter(d: NodeDeps): AdapterFactory {
  return async (cfg, { root, log, signal }) => {
    const node = await d.node();
    if (!node) throw new Error('Node.js (node) was not found on PATH.');
    const server = await d.jsDebug();
    if (!server) throw new Error(JS_DEBUG_SETUP);
    let args: Record<string, unknown>;
    if (cfg.request === 'launch') {
      const program = cfg.program?.trim();
      if (!program) throw new Error('Set the program to run (a .js/.mjs/.cjs file relative to the workspace).');
      args = {
        type: 'pwa-node', name: cfg.name, request: 'launch', program: path.resolve(root, program), args: splitArgs(cfg.args ?? ''),
        cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root, env: cfg.env ?? {}, runtimeExecutable: node, console: 'internalConsole',
        skipFiles: ['<node_internals>/**'], sourceMaps: true,
      };
    } else {
      args = { type: 'pwa-node', name: cfg.name, request: 'attach', address: cfg.hostName || '127.0.0.1', port: cfg.port ?? 9229, skipFiles: ['<node_internals>/**'] };
    }
    log(`js-debug: ${server} · node: ${node}`);
    const srv = await startServer(node, server, log, signal);
    const connect = async () => new DapConnection(await DapConnection.connect(srv.port));
    let conn: DapConnection;
    try { conn = await connect(); } catch (e) { srv.kill(); throw e; }
    conn.on('close', () => srv.kill()); // the launcher session ends last; the server (and any child connection) goes with it
    return { conn, args, openChild: connect };
  };
}
