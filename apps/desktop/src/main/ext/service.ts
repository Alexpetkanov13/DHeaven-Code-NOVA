import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkCapability, PERMISSIONS, type GrantState, type HostToMain, type Permission, type Manifest } from '@nova/extension-api';
import { ExtensionHost, type HostState } from './hostProcess';
import type { ExtensionStore, InstalledExtension } from './store';
import { listDir, readFile, writeFile } from '../workspaceFs';

export type ExtRuntimeStatus = 'inactive' | 'activating' | 'active' | 'error' | 'quarantined' | 'disabled' | 'blocked';
interface Runtime { status: ExtRuntimeStatus; activationMs: number | null; activatedBy: string | null; lastError: string | null; logs: string[]; commands: Set<string>; views: Set<string> }
export interface ServiceDeps {
  store: ExtensionStore; hostScript: string; execPath?: string;
  workspace(): { root: string; trusted: boolean } | null;
  emit(name: string, payload: unknown): void;
  askPermission(extId: string, displayName: string, perm: Permission): Promise<{ grant: GrantState; remember: boolean }>;
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
  commandTimeoutMs?: number;
}
const MAX_LOG = 500;
const MAX_CHANNEL = 1024 * 1024;

/** Owns extension activation, the host process, capability-checked API calls and contribution data. */
export class ExtensionService {
  private host: ExtensionHost | null = null;
  private rt = new Map<string, Runtime>();
  private crashes: number[] = [];
  hostState: HostState = 'stopped';
  hostError: string | null = null;
  private channels = new Map<string, { extId: string; name: string; text: string }>();
  private status = new Map<string, { extId: string; text: string; tooltip?: string; command?: string; visible: boolean }>();
  private sessionGrants = new Map<string, GrantState>(); // "ask every time" answers for this session
  constructor(private d: ServiceDeps) {}

  private r(id: string): Runtime {
    let x = this.rt.get(id);
    if (!x) { x = { status: 'inactive', activationMs: null, activatedBy: null, lastError: null, logs: [], commands: new Set(), views: new Set() }; this.rt.set(id, x); }
    return x;
  }
  private log(id: string | null, level: string, msg: string) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${level.toUpperCase()} ${msg}`;
    if (id) { const r = this.r(id); r.logs.push(line); if (r.logs.length > MAX_LOG) r.logs.splice(0, r.logs.length - MAX_LOG); }
    else this.hostLogs.push(line);
    if (this.hostLogs.length > MAX_LOG) this.hostLogs.splice(0, this.hostLogs.length - MAX_LOG);
  }
  hostLogs: string[] = [];
  private changed() { this.d.emit('ext.changed.v1', {}); }

  async list() {
    const ws = this.d.workspace();
    return (await this.d.store.list()).map((x) => {
      const r = this.r(x.id); const e = x.entry;
      const status: ExtRuntimeStatus = !e.enabled ? 'disabled' : e.quarantined ? 'quarantined' : r.status === 'inactive' && x.manifest.main && (!ws || !ws.trusted) ? 'blocked' : r.status;
      return {
        id: x.id, displayName: x.manifest.displayName, publisher: x.manifest.publisher, version: x.manifest.version, description: x.manifest.description, license: x.manifest.license ?? null,
        enabled: e.enabled, status, quarantined: e.quarantined, previousVersion: e.previous, sha256: e.sha256, source: e.source, installedAt: e.installedAt, path: x.dir,
        engines: x.manifest.engines.nova, activationEvents: x.manifest.activationEvents, hasCode: !!x.manifest.main,
        permissions: x.manifest.permissions.map((p) => ({ id: p, description: PERMISSIONS[p as Permission], grant: e.grants[p] ?? null })),
        contributes: summarize(x.manifest), activationMs: r.activationMs, activatedBy: r.activatedBy, lastError: r.lastError,
        configuration: Object.entries(x.manifest.contributes.configuration.properties).map(([key, p]) => ({ key, ...p, value: e.config[key] ?? p.default })),
      };
    });
  }
  logs(id: string) { return this.r(id).logs; }
  hostInfo() { return { state: this.hostState, pid: this.host?.pid ?? null, startupMs: this.host?.readyMs ?? null, error: this.hostError, crashes: this.crashes.length, logs: this.hostLogs.slice(-200) }; }

  /** Declarative contributions of enabled extensions (no code runs for these; safe in Restricted Mode). */
  async contributions() {
    const out = { commands: [] as unknown[], editorContext: [] as unknown[], themes: [] as unknown[], languages: [] as unknown[], grammars: [] as unknown[], snippets: [] as unknown[], views: [] as unknown[], tasks: [] as unknown[], outputChannels: [] as unknown[], status: [...this.status.entries()].filter(([, s]) => s.visible).map(([key, s]) => ({ key, ...s })) };
    for (const x of await this.d.store.list()) {
      if (!x.entry.enabled) continue;
      const c = x.manifest.contributes; const ext = { extId: x.id, extName: x.manifest.displayName };
      const hidden = new Set(c.menus.commandPalette.filter((m) => m.when === 'never').map((m) => m.command));
      for (const cmd of c.commands) out.commands.push({ ...ext, ...cmd, palette: !hidden.has(cmd.command) });
      for (const m of c.menus['editor/context']) out.editorContext.push({ ...ext, ...m, title: c.commands.find((k) => k.command === m.command)?.title ?? m.command });
      for (const t of c.themes) out.themes.push({ ...ext, id: `${x.id}/${t.id}`, label: t.label, uiTheme: t.uiTheme, data: await readJson(x.dir, t.path) });
      for (const l of c.languages) out.languages.push({ ...ext, ...l, configurationData: l.configuration ? await readJson(x.dir, l.configuration) : null });
      for (const g of c.grammars) out.grammars.push({ ...ext, language: g.language, format: g.format, data: await readJson(x.dir, g.path) });
      for (const s of c.snippets) out.snippets.push({ ...ext, language: s.language, data: await readJson(x.dir, s.path) });
      for (const v of c.views) out.views.push({ ...ext, ...v, registered: this.r(x.id).views.has(v.id) });
      for (const t of c.tasks) out.tasks.push({ ...ext, ...t });
      for (const ch of c.outputChannels) out.outputChannels.push({ ...ext, name: ch });
    }
    return out;
  }
  outputChannels() { return [...this.channels.entries()].map(([key, c]) => ({ key, extId: c.extId, name: c.name, text: c.text })); }

  // ---------------- host lifecycle
  private async ensureHost(): Promise<ExtensionHost> {
    if (this.host && this.hostState === 'running') return this.host;
    if (this.hostState === 'failed') throw new Error(`Extension host failed: ${this.hostError}. Restart it from the Extensions view.`);
    if (!this.host) {
      const roots = [this.d.hostScript, this.d.store.root];
      const h = new ExtensionHost({ script: this.d.hostScript, readPaths: roots, execPath: this.d.execPath, env: {} }, (m) => this.onHostRequest(m));
      h.on('state', (s: HostState) => { this.hostState = s; this.d.emit('ext.host.v1', this.hostInfo()); });
      h.on('log', (extId: string | null, level: string, msg: string) => this.log(extId, level, msg));
      h.on('registered', (extId: string, kind: string, key: string) => { const r = this.r(extId); (kind === 'command' ? r.commands : r.views).add(key); if (kind === 'view') this.d.emit('ext.treeChanged.v1', { viewId: key }); });
      h.on('crash', (why: string, culprit: string | null) => void this.onCrash(h, why, culprit));
      this.host = h;
    }
    const h = this.host;
    if (h.state !== 'running') await h.start();
    this.log(null, 'info', `extension host started (pid ${h.pid}, ${h.readyMs} ms)`);
    return h;
  }
  private async onCrash(h: ExtensionHost, why: string, culprit: string | null) {
    if (this.host !== h) return;
    this.host = null;
    this.log(null, 'error', `extension host crashed: ${why}${culprit ? ` (blamed: ${culprit})` : ''}`);
    for (const [id, r] of this.rt) if (r.status === 'active' || r.status === 'activating') { r.status = 'inactive'; r.commands.clear(); r.views.clear(); this.log(id, 'warn', `deactivated: extension host crashed (${why})`); }
    for (const [k, s] of this.status) if (s.visible) this.status.delete(k);
    if (culprit) {
      const r = this.r(culprit); r.status = 'quarantined'; r.lastError = `Quarantined: ${why}`;
      this.log(culprit, 'error', `quarantined: ${why}. Re-enable it from the Extensions view to try again.`);
      await this.d.store.update(culprit, { quarantined: why }).catch(() => {});
    }
    const now = Date.now(); this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 3) { this.hostState = 'failed'; this.hostError = `crashed ${this.crashes.length} times in 60 s (last: ${why})`; }
    else { this.hostState = 'restarting'; this.hostError = why; }
    this.d.emit('ext.host.v1', this.hostInfo()); this.changed();
    if (this.hostState === 'restarting') setTimeout(() => { if (!this.host && this.hostState === 'restarting') void this.fire('onStartupFinished').catch(() => {}); }, 500 * 2 ** (this.crashes.length - 1));
  }
  async restartHost() { this.crashes = []; this.hostError = null; const h = this.host; this.host = null; this.hostState = 'stopped'; for (const r of this.rt.values()) if (r.status === 'active') r.status = 'inactive'; await h?.stop(); await this.fire('onStartupFinished'); this.changed(); }
  async stopAll() { const h = this.host; this.host = null; this.hostState = 'stopped'; for (const r of this.rt.values()) { if (r.status === 'active' || r.status === 'activating') r.status = 'inactive'; r.commands.clear(); r.views.clear(); } this.status.clear(); await h?.stop(); this.changed(); }

  // ---------------- activation
  private matches(m: Manifest, event: string) {
    return m.activationEvents.some((e) => e === '*' || e === event || (event === 'onStartupFinished' && e === '*'));
  }
  /** Fires an activation event: activates every enabled, non-quarantined extension listening for it (trusted workspaces only). */
  async fire(event: string) {
    const ws = this.d.workspace(); if (!ws?.trusted) return;
    for (const x of await this.d.store.list()) {
      if (!x.entry.enabled || x.entry.quarantined || !x.manifest.main || !this.matches(x.manifest, event)) continue;
      await this.activate(x, event).catch(() => {});
    }
  }
  private async activate(x: InstalledExtension, event: string) {
    const r = this.r(x.id);
    if (r.status === 'active' || r.status === 'activating') return;
    const ws = this.d.workspace();
    if (!ws?.trusted) throw new Error('Extensions do not run in Restricted Mode. Trust the folder to enable them.');
    r.status = 'activating'; r.lastError = null; this.changed();
    const t0 = Date.now();
    try {
      const h = await this.ensureHost();
      const res = await h.request<{ ms?: number }>('activate', { ext: { id: x.id, path: x.dir, manifest: x.manifest, config: this.config(x), state: x.entry.state }, event }, x.id, 10_000);
      r.status = 'active'; r.activationMs = res?.ms ?? Date.now() - t0; r.activatedBy = event;
      this.log(x.id, 'info', `activated by ${event} in ${r.activationMs} ms (round trip ${Date.now() - t0} ms)`);
    } catch (e) {
      if (r.status === 'activating') r.status = 'error';
      r.lastError = `Activation failed: ${e instanceof Error ? e.message : e}`;
      this.log(x.id, 'error', r.lastError);
      throw e;
    } finally { this.changed(); }
  }
  private config(x: InstalledExtension) {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(x.manifest.contributes.configuration.properties)) out[k] = x.entry.config[k] ?? p.default;
    return out;
  }

  async executeCommand(command: string, args: unknown[] = []) {
    const owner = (await this.d.store.list()).find((x) => x.manifest.contributes.commands.some((c) => c.command === command));
    if (!owner) throw new Error(`Unknown extension command: ${command}`);
    if (!owner.entry.enabled) throw new Error(`${owner.manifest.displayName} is disabled`);
    if (owner.entry.quarantined) throw new Error(`${owner.manifest.displayName} is quarantined: ${owner.entry.quarantined}`);
    if (!this.d.workspace()?.trusted) throw new Error('Extension commands do not run in Restricted Mode. Trust the folder first.');
    await this.fire(`onCommand:${command}`);
    const r = this.r(owner.id);
    if (r.status !== 'active') throw new Error(`${owner.manifest.displayName} is not active${r.lastError ? `: ${r.lastError}` : ''}`);
    try { return await this.host!.request('executeCommand', { command, args }, owner.id, this.d.commandTimeoutMs ?? 10_000); }
    catch (e) { r.lastError = `${command}: ${e instanceof Error ? e.message : e}`; this.log(owner.id, 'error', r.lastError); this.changed(); throw e; }
  }
  async treeChildren(viewId: string, element: unknown) {
    const owner = (await this.d.store.list()).find((x) => x.manifest.contributes.views.some((v) => v.id === viewId));
    if (!owner) throw new Error(`Unknown view ${viewId}`);
    await this.fire(`onView:${viewId}`);
    if (this.r(owner.id).status !== 'active') return [];
    return this.host!.request('getChildren', { viewId, element }, owner.id, 10_000);
  }
  async deactivate(id: string) {
    const r = this.r(id);
    if ((r.status === 'active') && this.host) await this.host.request('deactivate', { extId: id }, id, 5000).catch((e) => this.log(id, 'warn', `deactivate: ${e.message}`));
    r.status = 'inactive'; r.commands.clear(); r.views.clear();
    for (const [k, s] of this.status) if (s.extId === id) this.status.delete(k);
    this.changed();
  }

  // ---------------- capability-checked API surface for extensions
  private async onHostRequest(m: Extract<HostToMain, { t: 'req' }>): Promise<unknown> {
    const x = (await this.d.store.list()).find((e) => e.id === m.extId);
    if (!x) throw new Error('unknown extension');
    const p = (m.params ?? {}) as Record<string, unknown>;
    const decision = checkCapability(m.method, x.manifest.permissions, { ...x.entry.grants, ...Object.fromEntries([...this.sessionGrants].filter(([k]) => k.startsWith(`${x.id}|`)).map(([k, v]) => [k.split('|')[1]!, v])) });
    if ('ask' in decision) {
      const ans = await this.d.askPermission(x.id, x.manifest.displayName, decision.ask);
      if (ans.remember) await this.d.store.setGrant(x.id, decision.ask, ans.grant); else this.sessionGrants.set(`${x.id}|${decision.ask}`, ans.grant);
      this.log(x.id, ans.grant === 'granted' ? 'info' : 'warn', `permission '${decision.ask}' ${ans.grant} by user${ans.remember ? ' (remembered)' : ' (this session)'}`);
      this.changed();
      if (ans.grant !== 'granted') throw new Error(`Permission '${decision.ask}' was denied by the user`);
    } else if (!decision.allow) { this.log(x.id, 'warn', `blocked ${m.method}: ${decision.reason}`); throw new Error(decision.reason); }
    const ws = this.d.workspace();
    const needWs = () => { if (!ws) throw new Error('No workspace is open'); return ws.root; };
    const str = (v: unknown, max = 4096) => { if (typeof v !== 'string' || v.length > max) throw new Error('invalid argument'); return v; };
    switch (m.method) {
      case 'window.showMessage': this.d.emit('ext.message.v1', { extId: x.id, extName: x.manifest.displayName, level: str(p.level, 10), message: str(p.message, 2000) }); return null;
      case 'window.setStatus': {
        const key = str(p.key, 200); if (!key.startsWith(`${x.id}#`)) throw new Error('invalid status key');
        if (!p.visible) this.status.delete(key); else this.status.set(key, { extId: x.id, text: str(p.text, 200), tooltip: typeof p.tooltip === 'string' ? p.tooltip.slice(0, 500) : undefined, command: typeof p.command === 'string' ? p.command : undefined, visible: true });
        this.d.emit('ext.status.v1', [...this.status.entries()].map(([k, s]) => ({ key: k, ...s }))); return null;
      }
      case 'output.append': case 'output.clear': case 'output.show': {
        const name = str(p.channel, 64); const key = `${x.id}:${name}`;
        const ch = this.channels.get(key) ?? { extId: x.id, name, text: '' }; this.channels.set(key, ch);
        if (m.method === 'output.append') { ch.text = (ch.text + str(p.text, 256 * 1024)).slice(-MAX_CHANNEL); }
        if (m.method === 'output.clear') ch.text = '';
        this.d.emit('ext.output.v1', { key, extId: x.id, extName: x.manifest.displayName, name, text: ch.text, show: m.method === 'output.show' });
        return null;
      }
      case 'commands.execute': return this.executeCommand(str(p.command, 128), Array.isArray(p.args) ? p.args : []);
      case 'tree.refresh': this.d.emit('ext.treeChanged.v1', { viewId: str(p.viewId, 128) }); return null;
      case 'state.update': {
        const state = { ...x.entry.state, [str(p.key, 200)]: p.value };
        if (JSON.stringify(state).length > 256 * 1024) throw new Error('globalState exceeds 256 KB');
        await this.d.store.update(x.id, { state }); return null;
      }
      case 'workspace.readFile': { const f = await readFile(needWs(), str(p.rel)); if (f.content.length > 5 * 1024 * 1024) throw new Error('file larger than 5 MB'); return f.content; }
      case 'workspace.listDir': return (await listDir(needWs(), str(p.rel))).map((e) => ({ name: e.name, kind: e.kind }));
      case 'workspace.writeFile': await writeFile(needWs(), str(p.rel), str(p.content, 5 * 1024 * 1024)); return null;
      case 'net.fetch': {
        const url = new URL(str(p.url, 8192)); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) URLs are allowed');
        const init = (p.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
        const res = await this.d.fetch(url.toString(), { method: init.method, headers: init.headers, body: init.body });
        const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 5 * 1024 * 1024) throw new Error('response larger than 5 MB');
        return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text: buf.toString('utf8') };
      }
      case 'process.exec': {
        const cmd = str(p.command, 1024); const args = Array.isArray(p.args) ? p.args.map((a) => str(a, 8192)) : [];
        return new Promise((resolve) => {
          const c = spawn(cmd, args, { cwd: needWs(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '', err = '', timedOut = false;
          const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, 60_000);
          c.stdout.on('data', (b: Buffer) => { if (out.length < 1e6) out += b; }); c.stderr.on('data', (b: Buffer) => { if (err.length < 1e6) err += b; });
          c.on('error', (e) => { clearTimeout(t); resolve({ code: null, stdout: out, stderr: String(e.message), timedOut }); });
          c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: out, stderr: err, timedOut }); });
        });
      }
    }
    throw new Error(`Unknown API ${m.method}`);
  }
}

async function readJson(dir: string, rel: string): Promise<unknown> {
  const abs = path.resolve(dir, ...rel.split('/'));
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error('path outside extension');
  const st = await fs.stat(abs); if (st.size > 2 * 1024 * 1024) throw new Error(`${rel} larger than 2 MB`);
  try { return JSON.parse(await fs.readFile(abs, 'utf8')); } catch (e) { return { __error: `Could not parse ${rel}: ${e instanceof Error ? e.message : e}` }; }
}
function summarize(m: Manifest) {
  const c = m.contributes;
  return Object.fromEntries(Object.entries({ commands: c.commands.length, themes: c.themes.length, languages: c.languages.length, grammars: c.grammars.length, snippets: c.snippets.length, views: c.views.length, tasks: c.tasks.length, outputChannels: c.outputChannels.length, settings: Object.keys(c.configuration.properties).length, menus: c.menus['editor/context'].length }).filter(([, n]) => n > 0));
}
