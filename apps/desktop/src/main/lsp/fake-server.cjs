// Minimal fake LSP server used by unit tests. Not shipped.
let buf = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`); process.stdout.write(b); };
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, i).toString())[1]);
    if (buf.length < i + 4 + len) return;
    const m = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString()); buf = buf.subarray(i + 4 + len);
    handle(m);
  }
});
const slow = new Map();
function handle(m) {
  if (m.method === 'initialize') {
    send({ method: 'window/logMessage', params: { type: 3, message: 'fake ready ' + m.params.rootUri } });
    send({ id: 'reg1', method: 'client/registerCapability', params: { registrations: [{ id: 'x', method: 'textDocument/formatting' }] } });
    return send({ id: m.id, result: { capabilities: { hoverProvider: true, completionProvider: {}, textDocumentSync: 2 } } });
  }
  if (m.method === 'textDocument/didOpen') return send({ method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'fake error v' + m.params.textDocument.version, severity: 1 }] } });
  if (m.method === 'textDocument/hover') return send({ id: m.id, result: { contents: { kind: 'markdown', value: 'hover at ' + m.params.position.line + ' ' + m.params.textDocument.uri } } });
  if (m.method === 'textDocument/completion') { slow.set(m.id, setTimeout(() => send({ id: m.id, result: [] }), 5000)); return; }
  if (m.method === '$/cancelRequest') { clearTimeout(slow.get(m.params.id)); send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } }); process.stderr.write('got cancel ' + m.params.id + '\n'); return; }
  if (m.method === 'workspace/executeCommand' && m.params.command === 'crash') process.exit(3);
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
}
