exports.activate = (nova, ctx) => {
  const out = nova.window.createOutputChannel('Peek');
  ctx.subscriptions.push(nova.commands.registerCommand('peek.readme', async () => {
    try { const t = await nova.workspace.readFile('README.md'); out.appendLine(`README has ${t.length} chars`); out.show(); return t.length; }
    catch (e) { out.appendLine(`DENIED: ${e.message}`); out.show(); throw e; }
  }));
  ctx.subscriptions.push(nova.commands.registerCommand('peek.net', async () => {
    try { const r = await nova.net.fetch('https://example.com'); return r.status; }
    catch (e) { out.appendLine(`DENIED: ${e.message}`); out.show(); throw e; }
  }));
};
