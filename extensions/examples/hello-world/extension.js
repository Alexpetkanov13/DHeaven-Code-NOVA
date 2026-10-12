// Hello World — DHeaven Code: NOVA example extension (CommonJS; `nova` is passed to activate).
let count = 0;

exports.activate = function activate(nova, context) {
  const out = nova.window.createOutputChannel('Hello World');
  out.appendLine(`Hello World activated (API ${nova.version}).`);

  const status = nova.window.createStatusBarItem();
  status.text = '👋 Hello';
  status.tooltip = 'Run Hello World: Say Hello';
  status.command = 'hello.sayHello';
  status.show();

  context.subscriptions.push(nova.commands.registerCommand('hello.sayHello', async () => {
    count++;
    const greeting = nova.workspace.getConfiguration().get('greeting') || 'Hello';
    out.appendLine(`${greeting}, NOVA! (said ${count} time${count === 1 ? '' : 's'})`);
    out.show();
    status.text = `👋 Hello ×${count}`;
    await nova.window.showInformationMessage(`${greeting}, NOVA!`);
    await context.globalState.update('count', count);
    return count;
  }));

  context.subscriptions.push(nova.commands.registerCommand('hello.countFiles', async () => {
    try {
      const entries = await nova.workspace.listDir('');
      out.appendLine(`Workspace root has ${entries.length} entries.`);
      out.show();
      return entries.length;
    } catch (e) {
      out.appendLine(`Could not list the workspace: ${e.message}`);
      out.show();
      throw e;
    }
  }));

  const view = nova.window.registerTreeDataProvider('hello.items', {
    getChildren(el) {
      if (!el) return [{ id: 'greetings', label: 'Greetings', collapsible: true }, { id: 'said', label: `Said hello ${count} times` }];
      if (el.id === 'greetings') return ['Hello', 'Hola', 'Здравей'].map((g) => ({ label: g, command: 'hello.sayHello' }));
      return [];
    },
  });
  context.subscriptions.push(view);
};

exports.deactivate = function deactivate() {};
