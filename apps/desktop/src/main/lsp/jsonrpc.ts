/** LSP base-protocol framing: `Content-Length: N\r\n\r\n<utf8 json>`. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onMessage: (msg: unknown) => void, private maxBytes = 64 * 1024 * 1024) {}
  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) { if (this.buf.length > 8192 && this.buf.indexOf('Content-Length') < 0) this.buf = Buffer.alloc(0); return; }
      const header = this.buf.subarray(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = Number(m[1]);
      if (len > this.maxBytes) throw new Error(`LSP message too large: ${len}`);
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      try { this.onMessage(JSON.parse(body)); } catch { /* malformed JSON from server: skip */ }
    }
  }
}

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
