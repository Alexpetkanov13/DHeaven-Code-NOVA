exports.activate = (nova, ctx) => {
  ctx.subscriptions.push(nova.commands.registerCommand('bad.hang', () => { for (;;) { /* never returns */ } }));
  ctx.subscriptions.push(nova.commands.registerCommand('bad.fsEscape', () => require('fs').readFileSync('/etc/passwd', 'utf8')));
};
