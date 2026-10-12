import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LspManager } from '../lsp/manager';
import { discoverJdks } from '../jdk';
import { DebugManager, type DebugStatus } from './manager';
import { javaAdapter } from './java';
import { JAVA_DEBUG } from './java';

// Real JDT LS + java-debug against fixtures/java-gradle. Needs NOVA_SERVERS_DIR with jdtls + java-debug.
const serversDir = process.env.NOVA_SERVERS_DIR;
describe.skipIf(!serversDir || !JAVA_DEBUG.isInstalledSync(serversDir ?? ''))('java debugging (real JDT LS + java-debug)', () => {
  it('stops at a breakpoint, reads a local, steps, continues to exit', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-dap-'));
    const root = path.join(tmp, 'java-gradle');
    await fs.cp(path.resolve(__dirname, '../../../../../fixtures/java-gradle'), root, { recursive: true });
    const jdk = (await discoverJdks()).find((j) => j.major === 21)!;
    const lsp = new LspManager({ serversDir: serversDir!, storageDir: path.join(tmp, 'storage'), isTrusted: async () => true, jdkFor: async () => jdk, emit: () => {} });
    await lsp.setWorkspace(root);
    let rid = 0;
    const statuses: DebugStatus[] = []; const output: string[] = [];
    const dbg = new DebugManager({
      isTrusted: async () => true, saveBreakpoints: async () => {}, runPreLaunch: async () => 0,
      emit: (n, p) => { if (n === 'debug.status.v1') statuses.push(p as DebugStatus); if (n === 'debug.output.v1') output.push((p as { output: string }).output); },
      adapters: { java: javaAdapter({
        exec: (command, args, t) => lsp.request('java', `t${++rid}`, 'workspace/executeCommand', { command, arguments: args }, t),
        waitJdtReady: (t, s) => lsp.waitReady('java', t, s), jdkFor: async () => jdk, debugInstalled: () => true,
      }) },
    });
    await dbg.setWorkspace(root);
    const greeter = path.join(root, 'src/main/java/com/dheaven/demo/Greeter.java');
    await dbg.setBreakpoints(greeter, [{ line: 13 }]);
    const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(dbg.getStatus())}\n${output.join('')}`); await new Promise((r) => setTimeout(r, 200)); } };
    const sid = await dbg.start({ id: 'a', name: 'App', type: 'java', request: 'launch', mainClass: 'com.dheaven.demo.App' });
    await until(() => dbg.getStatus().state === 'stopped' || dbg.getStatus().state === 'terminated', 400_000);
    expect(dbg.getStatus()).toMatchObject({ state: 'stopped', reason: 'breakpoint' });
    const tid = dbg.getStatus().threadId!;
    const st = (await dbg.request(sid, 'stackTrace', { threadId: tid, startFrame: 0, levels: 20 })) as { stackFrames: { id: number; name: string; line: number }[] };
    expect(st.stackFrames[0]).toMatchObject({ line: 13 });
    const sc = (await dbg.request(sid, 'scopes', { frameId: st.stackFrames[0]!.id })) as { scopes: { variablesReference: number }[] };
    const vars = (await dbg.request(sid, 'variables', { variablesReference: sc.scopes[0]!.variablesReference })) as { variables: { name: string; value: string }[] };
    expect(vars.variables.find((v) => v.name === 'name')?.value).toContain('NOVA');
    const ev = (await dbg.request(sid, 'evaluate', { expression: 'prefix + "!"', frameId: st.stackFrames[0]!.id, context: 'watch' })) as { result: string };
    expect(ev.result).toContain('Hello!');
    await dbg.request(sid, 'next', { threadId: tid });
    await until(() => statuses.filter((s) => s.state === 'stopped').length >= 2, 30_000);
    expect(dbg.getStatus().reason).toBe('step');
    await dbg.request(sid, 'continue', { threadId: tid });
    await until(() => dbg.getStatus().state === 'terminated', 60_000);
    expect(output.join('')).toContain('Hello, NOVA!');
    await lsp.stopAll();
  }, 600_000);
});
