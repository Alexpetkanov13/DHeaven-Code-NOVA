import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DebugManager, type DebugStatus, type LaunchConfig } from './manager';
import { probeDebugpy, pythonAdapter, splitArgs } from './python';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasDebugpy = (() => { try { execFileSync(python, ['-c', 'import debugpy'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const fixture = path.resolve(__dirname, '../../../../../fixtures/python');

describe('python debug helpers', () => {
  it('splits program arguments like a shell (quotes, escapes), refusing unclosed quotes', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('  -q  tests/a.py::t ')).toEqual(['-q', 'tests/a.py::t']);
    expect(splitArgs(`"tests/a.py::t[a b]" 'x y' a\\ b ""`)).toEqual(['tests/a.py::t[a b]', 'x y', 'a b', '']);
    expect(splitArgs(`"say \\"hi\\"" 'it\\'`)).toEqual(['say "hi"', 'it\\']);
    expect(() => splitArgs('"open')).toThrow(/Unclosed " quote/);
  });
  it('names the interpreter and the pip command when debugpy is missing, and when python cannot run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-py-'));
    // An interpreter whose stderr looks like CPython's when the module is absent.
    const fake = path.join(dir, process.platform === 'win32' ? 'fakepy.cmd' : 'fakepy');
    await fs.writeFile(fake, process.platform === 'win32' ? "@echo off\r\necho ModuleNotFoundError: No module named 'debugpy' 1>&2\r\nexit /b 1\r\n" : "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'debugpy'\" >&2\nexit 1\n", { mode: 0o755 });
    if (process.platform !== 'win32') await expect(probeDebugpy(fake, dir)).rejects.toThrow(`debugpy is not installed for ${fake}. Install it with: ${fake} -m pip install debugpy`);
    await expect(probeDebugpy(path.join(dir, 'no-such-python'), dir)).rejects.toThrow(/Cannot run .*no-such-python/);
  });
});

describe.skipIf(!hasDebugpy)(`python debugging (real debugpy via ${python})`, () => {
  async function session(cfg: Partial<LaunchConfig>, bp: { file: string; line: number }) {
    const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nova-pydbg-')), 'python');
    await fs.cp(fixture, root, { recursive: true });
    const statuses: DebugStatus[] = []; const output: string[] = [];
    const dbg = new DebugManager({
      isTrusted: async () => true, saveBreakpoints: async () => {}, runPreLaunch: async () => 0,
      emit: (n, p) => { if (n === 'debug.status.v1') statuses.push(p as DebugStatus); if (n === 'debug.output.v1') output.push((p as { output: string }).output); },
      adapters: { python: pythonAdapter({ pythonFor: async () => ({ command: python, source: 'test' }) }) },
    });
    await dbg.setWorkspace(root);
    await dbg.setBreakpoints(path.join(root, bp.file), [{ line: bp.line }]);
    const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timeout; last=${JSON.stringify(dbg.getStatus())}\n${output.join('')}`); await new Promise((r) => setTimeout(r, 100)); } };
    const sid = await dbg.start({ id: 'p', name: 'Py', type: 'python', request: 'launch', ...cfg });
    await until(() => dbg.getStatus().state === 'stopped' || dbg.getStatus().state === 'terminated', 60_000);
    return { dbg, sid, statuses, output, until, root };
  }

  it('module launch: stops at a breakpoint, reads a local, evaluates, steps, continues to exit with output', async () => {
    const { dbg, sid, statuses, output, until, root } = await session({ module: 'app.main' }, { file: 'app/greeter.py', line: 6 });
    expect(dbg.getStatus()).toMatchObject({ state: 'stopped', reason: 'breakpoint' });
    const tid = dbg.getStatus().threadId!;
    const st = (await dbg.request(sid, 'stackTrace', { threadId: tid, startFrame: 0, levels: 20 })) as { stackFrames: { id: number; name: string; line: number }[] };
    expect(st.stackFrames[0]).toMatchObject({ name: 'greet', line: 6 });
    const sc = (await dbg.request(sid, 'scopes', { frameId: st.stackFrames[0]!.id })) as { scopes: { name: string; variablesReference: number }[] };
    const vars = (await dbg.request(sid, 'variables', { variablesReference: sc.scopes[0]!.variablesReference })) as { variables: { name: string; value: string }[] };
    expect(vars.variables.find((v) => v.name === 'name')?.value).toBe("'NOVA'");
    const ev = (await dbg.request(sid, 'evaluate', { expression: 'name.upper() + punctuation', frameId: st.stackFrames[0]!.id, context: 'repl' })) as { result: string };
    expect(ev.result).toBe("'NOVA!'");
    await dbg.request(sid, 'next', { threadId: tid });
    await until(() => statuses.filter((s) => s.state === 'stopped').length >= 2, 30_000);
    expect(dbg.getStatus().reason).toBe('step');
    // main.py calls greet() three times: removing the breakpoint mid-session (sent to debugpy live) lets it run to the end.
    expect(await dbg.setBreakpoints(path.join(root, 'app/greeter.py'), [])).toEqual([]);
    await dbg.request(sid, 'continue', { threadId: tid });
    await until(() => dbg.getStatus().state === 'terminated', 60_000);
    await until(() => output.join('').includes('Process exited with code 0'), 10_000);
    expect(output.join('')).toContain('Hello, NOVA!');
  }, 120_000);

  it('pytest under the debugger: -m pytest <node id> stops inside the test', async () => {
    const { dbg, sid, until } = await session({ module: 'pytest', args: '-q tests/test_greeter.py::test_greets_by_name' }, { file: 'tests/test_greeter.py', line: 10 });
    expect(dbg.getStatus()).toMatchObject({ state: 'stopped', reason: 'breakpoint' });
    const st = (await dbg.request(sid, 'stackTrace', { threadId: dbg.getStatus().threadId!, startFrame: 0, levels: 5 })) as { stackFrames: { name: string }[] };
    expect(st.stackFrames[0]!.name).toBe('test_greets_by_name');
    await dbg.request(sid, 'continue', { threadId: dbg.getStatus().threadId! });
    await until(() => dbg.getStatus().state === 'terminated', 60_000);
  }, 120_000);

  it('program and module together are refused before anything starts', async () => {
    const { dbg } = await session({ module: 'app.main', program: 'app/main.py' }, { file: 'app/greeter.py', line: 6 });
    expect(dbg.getStatus()).toMatchObject({ state: 'terminated', reason: expect.stringMatching(/either a program .* or a module/) });
  }, 60_000);
});
