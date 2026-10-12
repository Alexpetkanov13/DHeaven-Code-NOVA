import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { FrameDecoder, encodeFrame } from '../lsp/jsonrpc';
import { DapConnection } from './connection';
import { DebugManager, type DebugStatus } from './manager';

/** Minimal in-process fake adapter: answers initialize/launch/setBreakpoints, then stops on a breakpoint. */
function fakeAdapter(behaviour: { crashAfterLaunch?: boolean }) {
  return new Promise<{ port: number; server: net.Server; got: string[] }>((resolve) => {
    const got: string[] = [];
    const server = net.createServer((sock) => {
      let seq = 1;
      const send = (m: object) => sock.write(encodeFrame({ seq: seq++, ...m }));
      const dec = new FrameDecoder((raw) => {
        const m = raw as { seq: number; command: string; arguments: Record<string, unknown> };
        got.push(m.command);
        const ok = (body: unknown = {}) => send({ type: 'response', request_seq: m.seq, command: m.command, success: true, body });
        switch (m.command) {
          case 'initialize': ok({ supportsConfigurationDoneRequest: true, supportsConditionalBreakpoints: true, supportsLogPoints: false }); send({ type: 'event', event: 'initialized' }); break;
          case 'launch': ok(); if (behaviour.crashAfterLaunch) setTimeout(() => sock.destroy(), 50); break;
          case 'setBreakpoints': ok({ breakpoints: (m.arguments.breakpoints as { line: number; condition?: string; logMessage?: string }[]).map((b) => ({ verified: true, line: b.line, message: JSON.stringify(b) })) }); break;
          case 'configurationDone': ok(); setTimeout(() => send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }), 20); break;
          case 'threads': ok({ threads: [{ id: 1, name: 'main' }] }); break;
          case 'evaluate': send({ type: 'response', request_seq: m.seq, command: m.command, success: false, message: 'boom' }); break;
          case 'disconnect': ok(); sock.end(); break;
          default: ok();
        }
      });
      sock.on('data', (c) => dec.push(c));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, server, got }));
  });
}

function mk(port: number, trusted = true) {
  const statuses: DebugStatus[] = [];
  const dbg = new DebugManager({
    isTrusted: async () => trusted, saveBreakpoints: async () => {}, runPreLaunch: async () => 0,
    emit: (n, p) => { if (n === 'debug.status.v1') statuses.push(p as DebugStatus); },
    adapters: { java: async () => ({ conn: new DapConnection(await DapConnection.connect(port)), args: { mainClass: 'X' } }) },
  });
  return { dbg, statuses };
}
const until = async (pred: () => boolean) => { const end = Date.now() + 5000; while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const cfg = { id: '1', name: 'x', type: 'java' as const, request: 'launch' as const };

describe('DebugManager', () => {
  it('handshake, breakpoints (capability-filtered), stopped event, allowlist, adapter errors', async () => {
    const { port, server, got } = await fakeAdapter({});
    const { dbg } = mk(port);
    await dbg.setWorkspace('/w');
    await dbg.setBreakpoints('/w/A.java', [{ line: 3, condition: 'i > 2', logMessage: 'not supported here' }]);
    const sid = await dbg.start(cfg);
    await until(() => dbg.getStatus().state === 'stopped');
    expect(got.slice(0, 4)).toEqual(['initialize', 'launch', 'setBreakpoints', 'setExceptionBreakpoints']);
    const v = dbg.getBreakpoints().verified['/w/A.java']!;
    expect(JSON.parse(v[0]!.message!)).toEqual({ line: 3, condition: 'i > 2' }); // logpoint dropped: adapter lacks supportsLogPoints
    expect(await dbg.request(sid, 'threads', {})).toEqual({ threads: [{ id: 1, name: 'main' }] });
    await expect(dbg.request(sid, 'evaluate', { expression: '1' })).rejects.toThrow('boom');
    await expect(dbg.request(sid, 'disconnect', {})).rejects.toThrow('not allowed');
    await expect(dbg.request(sid + 1, 'threads', {})).rejects.toThrow('No active');
    await dbg.stop();
    expect(got).toContain('disconnect');
    expect(dbg.getStatus().state).toBe('terminated');
    server.close();
  });
  it('adapter crash ends the session cleanly (no throw), a new session can start', async () => {
    const { port, server } = await fakeAdapter({ crashAfterLaunch: true });
    const { dbg } = mk(port);
    await dbg.setWorkspace('/w');
    await dbg.start(cfg);
    await until(() => dbg.getStatus().state === 'terminated');
    expect(dbg.getStatus().reason).toMatch(/Adapter disconnected|failed/);
    await dbg.start(cfg);
    await until(() => dbg.getStatus().state === 'terminated');
    server.close();
  });
  it('refuses to start in an untrusted workspace', async () => {
    const { dbg } = mk(1, false);
    await dbg.setWorkspace('/w');
    await expect(dbg.start(cfg)).rejects.toThrow('UNTRUSTED');
  });
});
