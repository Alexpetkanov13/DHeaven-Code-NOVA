/**
 * NOVA extension host. Runs as a separate Node process (Electron binary with ELECTRON_RUN_AS_NODE) started by main with
 * Node's permission model: fs reads only for this script and installed extensions; no fs writes, child processes,
 * workers or native addons. Extension code additionally runs in a vm context without `process`, `require('fs')`,
 * `fetch` etc.; everything it can do goes through the capability-checked RPC to main.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { API_VERSION, type Disposable, type ExtensionModule, type HostExtension, type HostToMain, type MainToHost, type NovaApi, type TreeDataProvider, type TreeItem } from '@nova/extension-api';

const send = (m: HostToMain) => process.send!(m);
const log = (extId: string | null, level: 'info' | 'warn' | 'error', message: string) => send({ t: 'log', extId, level, message });

let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
function rpc(extId: string, method: string, params: unknown): Promise<unknown> {
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ t: 'req', id, extId, method, params }); });
}

interface Loaded { ext: HostExtension; mod: ExtensionModule; subs: Disposable[] }
const loaded = new Map<string, Loaded>();
const commands = new Map<string, { extId: string; fn: (...a: unknown[]) => unknown }>();
const trees = new Map<string, { extId: string; provider: TreeDataProvider; items: Map<string, TreeItem> }>();

const SAFE_BUILTINS = new Set(['path', 'util', 'events', 'url', 'assert', 'buffer', 'string_decoder', 'querystring']);
const errMsg = (e: unknown) => (e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 6).join('\n')}` : ''}` : String(e));

function makeApi(ext: HostExtension, subs: Disposable[]): NovaApi {
  const id = ext.id;
  const call = (m: string, p: unknown) => rpc(id, m, p);
  return Object.freeze({
    version: API_VERSION,
    commands: Object.freeze({
      registerCommand(cmd: string, fn: (...a: unknown[]) => unknown) {
        if (!ext.manifest.contributes.commands.some((c) => c.command === cmd)) throw new Error(`Command '${cmd}' must be declared in contributes.commands`);
        if (commands.has(cmd)) throw new Error(`Command '${cmd}' is already registered`);
        commands.set(cmd, { extId: id, fn }); send({ t: 'registered', extId: id, kind: 'command', key: cmd });
        const d = { dispose: () => { if (commands.get(cmd)?.extId === id) commands.delete(cmd); } }; subs.push(d); return d;
      },
      executeCommand: <T>(cmd: string, ...args: unknown[]) => call('commands.execute', { command: cmd, args }) as Promise<T>,
    }),
    window: Object.freeze({
      showInformationMessage: async (message: string) => { await call('window.showMessage', { level: 'info', message: String(message) }); },
      showWarningMessage: async (message: string) => { await call('window.showMessage', { level: 'warn', message: String(message) }); },
      showErrorMessage: async (message: string) => { await call('window.showMessage', { level: 'error', message: String(message) }); },
      createOutputChannel(name: string) {
        const ch = String(name).slice(0, 64);
        const fire = (m: string, p: object) => void call(m, { channel: ch, ...p }).catch((e) => log(id, 'error', `output: ${errMsg(e)}`));
        return Object.freeze({ name: ch, append: (t: string) => fire('output.append', { text: String(t) }), appendLine: (t: string) => fire('output.append', { text: `${t}\n` }), clear: () => fire('output.clear', {}), show: () => fire('output.show', {}), dispose: () => {} });
      },
      createStatusBarItem() {
        const key = `${id}#${++seq}`;
        const st = { text: '', tooltip: undefined as string | undefined, command: undefined as string | undefined, visible: false };
        const push = () => void call('window.setStatus', { key, ...st }).catch(() => {});
        const item = {
          get text() { return st.text; }, set text(v: string) { st.text = String(v).slice(0, 200); if (st.visible) push(); },
          get tooltip() { return st.tooltip; }, set tooltip(v: string | undefined) { st.tooltip = v; if (st.visible) push(); },
          get command() { return st.command; }, set command(v: string | undefined) { st.command = v; if (st.visible) push(); },
          show() { st.visible = true; push(); }, hide() { st.visible = false; push(); }, dispose() { st.visible = false; push(); },
        };
        subs.push(item); return item;
      },
      registerTreeDataProvider(viewId: string, provider: TreeDataProvider) {
        if (!ext.manifest.contributes.views.some((v) => v.id === viewId)) throw new Error(`View '${viewId}' must be declared in contributes.views`);
        trees.set(viewId, { extId: id, provider, items: new Map() }); send({ t: 'registered', extId: id, kind: 'view', key: viewId });
        const d = { refresh: () => void call('tree.refresh', { viewId }).catch(() => {}), dispose: () => { trees.delete(viewId); } }; subs.push(d); return d;
      },
    }),
    workspace: Object.freeze({
      getConfiguration: () => ({ get: <T>(key: string) => ext.config[key] as T | undefined }),
      readFile: (rel: string) => call('workspace.readFile', { rel }) as Promise<string>,
      listDir: (rel: string) => call('workspace.listDir', { rel }) as Promise<{ name: string; kind: 'file' | 'dir' }[]>,
      writeFile: async (rel: string, content: string) => { await call('workspace.writeFile', { rel, content: String(content) }); },
    }),
    net: Object.freeze({ fetch: (url: string, init?: object) => call('net.fetch', { url, init: init ?? {} }) as ReturnType<NovaApi['net']['fetch']> }),
    process: Object.freeze({ exec: (command: string, args: string[]) => call('process.exec', { command, args }) as ReturnType<NovaApi['process']['exec']> }),
  }) as NovaApi;
}

function loadModule(ext: HostExtension): ExtensionModule {
  const root = path.resolve(ext.path);
  const sandboxConsole = Object.freeze({
    log: (...a: unknown[]) => log(ext.id, 'info', a.map(String).join(' ')), info: (...a: unknown[]) => log(ext.id, 'info', a.map(String).join(' ')),
    warn: (...a: unknown[]) => log(ext.id, 'warn', a.map(String).join(' ')), error: (...a: unknown[]) => log(ext.id, 'error', a.map(String).join(' ')),
  });
  const ctx = vm.createContext({ console: sandboxConsole, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, atob, btoa }, { name: `ext:${ext.id}`, codeGeneration: { strings: false, wasm: false } });
  const cache = new Map<string, { exports: unknown }>();
  const load = (file: string): unknown => {
    const abs = path.resolve(file);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`require outside the extension folder is not allowed: ${file}`);
    const hit = cache.get(abs); if (hit) return hit.exports;
    const src = fs.readFileSync(abs, 'utf8');
    const module = { exports: {} as unknown }; cache.set(abs, module);
    if (abs.endsWith('.json')) { module.exports = JSON.parse(src); return module.exports; }
    const fn = vm.runInContext(`(function (module, exports, require, __filename, __dirname) {${src}\n})`, ctx, { filename: abs, timeout: 2000 }) as (...a: unknown[]) => void;
    const req = (spec: string) => {
      const name = spec.replace(/^node:/, '');
      if (SAFE_BUILTINS.has(name)) return require(name);
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const base = path.resolve(path.dirname(abs), spec);
        for (const c of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return load(c);
        throw new Error(`Cannot find module '${spec}'`);
      }
      throw new Error(`Module '${spec}' is not available to NOVA extensions. Use the nova API (file, network and process access need permissions).`);
    };
    fn(module, module.exports, req, abs, path.dirname(abs));
    return module.exports;
  };
  return load(path.join(root, ext.manifest.main!)) as ExtensionModule;
}

async function handle(m: Extract<MainToHost, { t: 'req' }>): Promise<unknown> {
  switch (m.method) {
    case 'ping': return 'pong';
    case 'activate': {
      const { ext } = m.params;
      if (loaded.has(ext.id)) return { already: true };
      const subs: Disposable[] = [];
      const t0 = performance.now();
      const mod = loadModule(ext);
      const stateStore = { ...ext.state };
      const context = Object.freeze({
        extensionId: ext.id, extensionPath: ext.path, subscriptions: subs,
        globalState: Object.freeze({ get: <T,>(k: string) => stateStore[k] as T | undefined, update: async (k: string, v: unknown) => { stateStore[k] = v; await rpc(ext.id, 'state.update', { key: k, value: v }); } }),
      });
      loaded.set(ext.id, { ext, mod, subs });
      try { await mod.activate?.(makeApi(ext, subs), context); } catch (e) {
        for (const s of subs) try { s.dispose(); } catch { /* ignore */ }
        loaded.delete(ext.id); throw e;
      }
      return { ms: Math.round(performance.now() - t0) };
    }
    case 'deactivate': {
      const l = loaded.get(m.params.extId); if (!l) return null;
      try { await l.mod.deactivate?.(); } finally { for (const s of l.subs) try { s.dispose(); } catch { /* ignore */ } loaded.delete(m.params.extId); }
      return null;
    }
    case 'executeCommand': {
      const c = commands.get(m.params.command);
      if (!c) throw new Error(`Command '${m.params.command}' is not registered (extension not active?)`);
      const r = await c.fn(...(m.params.args ?? []));
      try { return JSON.parse(JSON.stringify(r ?? null)); } catch { return null; }
    }
    case 'getChildren': {
      const t = trees.get(m.params.viewId); if (!t) throw new Error(`No tree provider for ${m.params.viewId}`);
      const parent = m.params.element ? t.items.get((m.params.element as { id: string }).id) : undefined;
      const kids = (await t.provider.getChildren(parent)) ?? [];
      return kids.slice(0, 1000).map((k, i) => {
        const id = String(k.id ?? `${(parent?.id ?? '')}/${i}:${k.label}`);
        t.items.set(id, { ...k, id });
        return { id, label: String(k.label), description: k.description, tooltip: k.tooltip, collapsible: !!k.collapsible, command: k.command, commandArgs: k.commandArgs };
      });
    }
  }
}

process.on('message', (m: MainToHost) => {
  if (m.t === 'res') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result); return; }
  void handle(m).then((result) => send({ t: 'res', id: m.id, result: result ?? null }), (e) => send({ t: 'res', id: m.id, error: errMsg(e) }));
});
process.on('uncaughtException', (e) => log(null, 'error', `uncaught: ${errMsg(e)}`));
process.on('unhandledRejection', (e) => log(null, 'error', `unhandled rejection: ${errMsg(e)}`));
process.on('disconnect', () => process.exit(0));
send({ t: 'ready' });
