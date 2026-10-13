import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DebugManager, type DebugStatus } from './manager';
import { nodeAdapter } from './node';
import { findExecutable } from '../lsp/discover';

// Real js-debug (dapDebugServer.js) from NOVA_SERVERS_DIR/js-debug, the layout of the js-debug-dap release.
const jsDebug = process.env.NOVA_SERVERS_DIR ? path.join(process.env.NOVA_SERVERS_DIR, 'js-debug', 'src', 'dapDebugServer.js') : '';
const fixture = path.resolve(__dirname, '../../../../../fixtures/node-app');

describe.skipIf(!jsDebug || !fs.existsSync(jsDebug))('node debugging (real js-debug, child session via startDebugging)', () => {
  it('stops at a breakpoint in the child session, reads locals, evaluates, steps, removes the breakpoint, runs to exit', async () => {
    const root = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-nodedbg-')), 'node-app');
    await fsp.cp(fixture, root, { recursive: true });
    const statuses: DebugStatus[] = []; const output: string[] = [];
    const dbg = new DebugManager({
      isTrusted: async () => true, saveBreakpoints: async () => {}, runPreLaunch: async () => 0,
      emit: (n, p) => { if (n === 'debug.status.v1') statuses.push(p as DebugStatus); if (n === 'debug.output.v1') output.push((p as { output: string }).output); },
      adapters: { node: nodeAdapter({ node: () => findExecutable(['node']), jsDebug: async () => jsDebug }) },
    });
    await dbg.setWorkspace(root);
    const greeter = path.join(root, 'src/greeter.js');
    await dbg.setBreakpoints(greeter, [{ line: 3 }]);
    const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(dbg.getStatus())}\n${output.join('')}`); await new Promise((r) => setTimeout(r, 100)); } };
    const sid = await dbg.start({ id: 'n', name: 'Node', type: 'node', request: 'launch', program: 'src/main.js' });
    await until(() => dbg.getStatus().state === 'stopped' || dbg.getStatus().state === 'terminated', 60_000);
    expect(dbg.getStatus()).toMatchObject({ state: 'stopped', reason: 'breakpoint' });
    const tid = dbg.getStatus().threadId!;
    const st = (await dbg.request(sid, 'stackTrace', { threadId: tid, startFrame: 0, levels: 20 })) as { stackFrames: { id: number; name: string; line: number; source?: { path?: string } }[] };
    expect(st.stackFrames[0]).toMatchObject({ name: expect.stringMatching(/(^|\.)greet$/), line: 3 }); // js-debug: 'global.greet'
    expect(st.stackFrames[0]!.source?.path).toBe(greeter);
    const sc = (await dbg.request(sid, 'scopes', { frameId: st.stackFrames[0]!.id })) as { scopes: { name: string; variablesReference: number }[] };
    const vars = (await dbg.request(sid, 'variables', { variablesReference: sc.scopes[0]!.variablesReference })) as { variables: { name: string; value: string }[] };
    expect(vars.variables.find((v) => v.name === 'name')?.value).toBe("'NOVA'"); // V8 doesn't list the `const` at the return
    const ev = (await dbg.request(sid, 'evaluate', { expression: 'name.toUpperCase() + punctuation', frameId: st.stackFrames[0]!.id, context: 'repl' })) as { result: string };
    expect(ev.result).toBe("'NOVA!'");
    await dbg.request(sid, 'next', { threadId: tid });
    await until(() => statuses.filter((s) => s.state === 'stopped').length >= 2, 30_000);
    expect(dbg.getStatus().reason).toBe('step');
    expect(await dbg.setBreakpoints(greeter, [])).toEqual([]);
    await dbg.request(sid, 'continue', { threadId: dbg.getStatus().threadId! });
    await until(() => dbg.getStatus().state === 'terminated', 60_000);
    await until(() => output.join('').includes('Hello, Rust!'), 10_000);
    expect(output.join('')).toContain('Hello, NOVA!');
    await dbg.stop();
  }, 120_000);

  it('missing js-debug: the session fails with setup guidance, nothing is downloaded', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-nodedbg-'));
    const output: string[] = [];
    const dbg = new DebugManager({
      isTrusted: async () => true, saveBreakpoints: async () => {}, runPreLaunch: async () => 0,
      emit: (n, p) => { if (n === 'debug.output.v1') output.push((p as { output: string }).output); },
      adapters: { node: nodeAdapter({ node: () => findExecutable(['node']), jsDebug: async () => null }) },
    });
    await dbg.setWorkspace(root);
    await dbg.start({ id: 'n', name: 'Node', type: 'node', request: 'launch', program: 'main.js' });
    const end = Date.now() + 10_000; while (dbg.getStatus().state !== 'terminated' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(dbg.getStatus().reason).toMatch(/js-debug-dap-v<version>\.tar\.gz.*Choose js-debug….*NOVA does not download it/);
  }, 30_000);
});
