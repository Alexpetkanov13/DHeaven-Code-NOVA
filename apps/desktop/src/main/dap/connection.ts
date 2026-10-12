import { EventEmitter } from 'node:events';
import net from 'node:net';
import { FrameDecoder, encodeFrame } from '../lsp/jsonrpc';

export class DapError extends Error { constructor(public command: string, message: string) { super(message); } }
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout; command: string };
interface DapMsg { seq: number; type: 'request' | 'response' | 'event'; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: unknown; arguments?: unknown }

/**
 * Debug Adapter Protocol client over any duplex stream (TCP socket for java-debug, stdio for others).
 * Events: 'event'(name, body), 'close'(reason). Reverse requests are answered by `onReverse`.
 */
export class DapConnection extends EventEmitter {
  private seq = 1;
  private pending = new Map<number, Pending>();
  closed = false;
  constructor(private stream: NodeJS.ReadWriteStream & { destroy?(): void }, private onReverse: (command: string, args: unknown) => unknown = () => { throw new Error('unsupported'); }) {
    super();
    const dec = new FrameDecoder((m) => this.onMessage(m as DapMsg));
    stream.on('data', (c: Buffer) => { try { dec.push(c); } catch (e) { this.close(`protocol error: ${e}`); } });
    stream.on('error', (e: Error) => this.close(`stream error: ${e.message}`));
    stream.on('close', () => this.close('adapter connection closed'));
    stream.on('end', () => this.close('adapter connection ended'));
  }
  static connect(port: number, host = '127.0.0.1', timeoutMs = 10_000): Promise<net.Socket> {
    return new Promise((res, rej) => {
      const s = net.connect({ port, host });
      const t = setTimeout(() => { s.destroy(); rej(new Error(`connect ${host}:${port} timed out`)); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); res(s); });
      s.once('error', (e) => { clearTimeout(t); rej(e); });
    });
  }
  private write(m: object) { if (!this.closed) this.stream.write(encodeFrame(m)); }
  request<T = unknown>(command: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new DapError(command, 'debug adapter is not connected'));
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new DapError(command, `${command} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject, timer, command });
      this.write({ seq, type: 'request', command, arguments: args });
    });
  }
  private onMessage(m: DapMsg) {
    if (m.type === 'response') {
      const p = this.pending.get(m.request_seq!); if (!p) return; // stale (timed out / cancelled)
      this.pending.delete(m.request_seq!); clearTimeout(p.timer);
      if (m.success) p.resolve(m.body ?? null); else p.reject(new DapError(p.command, m.message || `${p.command} failed`));
    } else if (m.type === 'event') this.emit('event', m.event, m.body ?? {});
    else if (m.type === 'request') {
      void Promise.resolve().then(() => this.onReverse(m.command!, m.arguments))
        .then((body) => this.write({ seq: this.seq++, type: 'response', request_seq: m.seq, command: m.command, success: true, body }))
        .catch((e) => this.write({ seq: this.seq++, type: 'response', request_seq: m.seq, command: m.command, success: false, message: String(e instanceof Error ? e.message : e) }));
    }
  }
  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DapError(p.command, `debug adapter disconnected (${reason})`)); }
    this.pending.clear();
    try { this.stream.destroy?.(); } catch { /* ignore */ }
    this.emit('close', reason);
  }
}
