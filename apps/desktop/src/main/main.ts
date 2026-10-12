import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { channels, isChannel, type Envelope, type ErrorCode, type WorkspaceInfo } from '@nova/ipc-contract';
import { Store } from './store';
import { listDir, readFile, writeFile, FsError, ExistsError, TrashError, statEntry, createEntry, renameEntry, deleteEntry } from './workspaceFs';
import { CoalescingWatcher } from './watcher';
import { TrustStore } from './trust';
import { DaemonClient, DaemonError } from './daemon';
import { applyReplace } from './replace';
import { LspManager } from './lsp/manager';
import { LspRequestError } from './lsp/server';
import { SERVERS } from './lsp/registry';
import { installServer } from './lsp/installer';
import { discoverJdks, probeJdk, type Jdk } from './jdk';
import { WorkspaceSettingsStore } from './workspaceSettings';
import type { EventName, Events } from '@nova/ipc-contract';
import { PathError, assertWithin, toRel } from './pathGuard';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Monaco injects inline styles (documented in ADR-0002)
  "img-src 'self' data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

if (process.env.NOVA_USER_DATA) app.setPath('userData', path.resolve(process.env.NOVA_USER_DATA));
protocol.registerSchemesAsPrivileged([{ scheme: 'nova', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const devUrl = process.env.NOVA_DEV_URL; // e.g. http://localhost:5173 when running `pnpm dev`
const rendererDir = path.join(__dirname, '../renderer');
let store: Store;
let workspace: WorkspaceInfo | null = null;
let win: BrowserWindow | null = null;
let watcher: CoalescingWatcher | null = null;
let trust: TrustStore;
let daemon: DaemonClient;
let lsp: LspManager;
const serversDir = () => (process.env.NOVA_SERVERS_DIR ? path.resolve(process.env.NOVA_SERVERS_DIR) : path.join(app.getPath('userData'), 'servers'));
let wsSettings: WorkspaceSettingsStore;
/** Effective JDK: workspace override → global setting → newest discovered. Returns null if none satisfies minMajor. */
async function jdkFor(root: string, minMajor: number, maxMajor = Infinity): Promise<Jdk | null> {
  const ok = (j: Jdk) => j.major >= minMajor && j.major <= maxMajor;
  const chosen = (await wsSettings.get(root)).javaHome ?? (await store.getSettings()).javaHome;
  if (chosen) {
    const j = await probeJdk(chosen, 'selected');
    if (j && ok(j)) return j;
  }
  return (await discoverJdks(chosen ? [chosen] : [])).find(ok) ?? null;
}
const ptys = new Set<number>();
const searches = new Set<number>();

function emit<E extends EventName>(name: E, payload: Events[E]) { win?.webContents.send('nova:event', name, payload); }

function daemonPath() {
  if (process.env.NOVA_DAEMON_PATH) return path.resolve(process.env.NOVA_DAEMON_PATH);
  const exe = process.platform === 'win32' ? 'novad.exe' : 'novad';
  return app.isPackaged ? path.join(process.resourcesPath, exe) : path.resolve(__dirname, '../../../../target/release', exe);
}
async function requireTrust() {
  const ws = needWs();
  if (!(await trust.isTrusted(ws.root))) throw new AppError('UNTRUSTED', 'This action requires a trusted workspace');
  return ws;
}
function killAllPtys() { for (const id of ptys) void daemon.call('pty.kill', { ptyId: id }).catch(() => {}); ptys.clear(); }

class AppError extends Error { constructor(public code: ErrorCode, m: string) { super(m); } }

async function openWorkspace(root: string): Promise<WorkspaceInfo> {
  const abs = path.resolve(root);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new AppError('NOT_FOUND', 'Folder does not exist');
  workspace = { root: await fs.realpath(abs), name: path.basename(abs) };
  watcher?.stop();
  killAllPtys();
  try { watcher = new CoalescingWatcher(workspace.root, (rels) => emit('fs.changed.v1', { rels })).start(); }
  catch { watcher = null; /* watching unsupported: tree refresh falls back to manual */ }
  await store.addRecent(workspace.root, workspace.name);
  win?.setTitle(`${workspace.name} — DHeaven Code: NOVA`);
  await lsp.setWorkspace(workspace.root);
  return workspace;
}
const needWs = () => { if (!workspace) throw new AppError('NO_WORKSPACE', 'No folder is open'); return workspace; };

type Handlers = { [C in keyof typeof channels]: (req: import('zod').output<(typeof channels)[C]['req']>) => Promise<unknown> };
const handlers: Handlers = {
  'app.info.v1': async () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }),
  'daemon.status.v1': async () => ({ state: daemon.state }),
  'workspace.openDialog.v1': async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    const p = r.filePaths[0];
    return r.canceled || !p ? null : openWorkspace(p);
  },
  'workspace.open.v1': async ({ root }) => openWorkspace(root),
  'workspace.current.v1': async () => workspace,
  'fs.list.v1': async ({ rel }) => listDir(needWs().root, rel),
  'fs.read.v1': async ({ rel }) => readFile(needWs().root, rel),
  'fs.write.v1': async ({ rel, content, expectedMtimeMs }) => writeFile(needWs().root, rel, content, expectedMtimeMs),
  'fs.saveAs.v1': async ({ suggestedRel, content }) => {
    const ws = needWs();
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(ws.root, suggestedRel) });
    if (r.canceled || !r.filePath) return null;
    assertWithin(ws.root, r.filePath); // Phase 1: save-as is restricted to the open workspace
    const rel = toRel(ws.root, r.filePath);
    return { rel, ...(await writeFile(ws.root, rel, content)) };
  },
  'fs.stat.v1': async ({ rel }) => statEntry(needWs().root, rel),
  'fs.create.v1': async ({ rel, kind }) => createEntry(needWs().root, rel, kind),
  'fs.rename.v1': async ({ from, to }) => renameEntry(needWs().root, from, to),
  'fs.delete.v1': async ({ rel, permanent }) => deleteEntry(needWs().root, rel, permanent, (abs) => shell.trashItem(abs)),
  'search.start.v1': async (p) => {
    const r = await daemon.call<{ searchId: number }>('search.start', { root: needWs().root, ...p });
    searches.add(r.searchId);
    return r;
  },
  'search.cancel.v1': async ({ searchId }) => { await daemon.call('search.cancel', { searchId }); return null; },
  'replace.apply.v1': async (p) => applyReplace(needWs().root, p.rels, p.query, p.isRegex, p.caseSensitive, p.replacement),
  'terminal.spawn.v1': async ({ cols, rows }) => {
    const ws = await requireTrust();
    const r = await daemon.call<{ ptyId: number }>('pty.spawn', { cwd: ws.root, cols, rows });
    ptys.add(r.ptyId);
    return r;
  },
  'terminal.write.v1': async ({ ptyId, data }) => { if (!ptys.has(ptyId)) throw new AppError('NOT_FOUND', 'No such terminal'); await daemon.call('pty.write', { ptyId, data }); return null; },
  'terminal.resize.v1': async ({ ptyId, cols, rows }) => { if (ptys.has(ptyId)) await daemon.call('pty.resize', { ptyId, cols, rows }); return null; },
  'terminal.kill.v1': async ({ ptyId }) => { if (ptys.has(ptyId)) await daemon.call('pty.kill', { ptyId }); return null; },
  'git.status.v1': async () => daemon.call('git.status', { root: needWs().root }),
  'git.show.v1': async ({ rel, rev }) => daemon.call('git.show', { root: needWs().root, path: rel, rev }),
  'git.stage.v1': async ({ rels }) => { await daemon.call('git.stage', { root: needWs().root, paths: rels }); return null; },
  'git.unstage.v1': async ({ rels }) => { await daemon.call('git.unstage', { root: needWs().root, paths: rels }); return null; },
  'git.commit.v1': async ({ message }) => daemon.call('git.commit', { root: (await requireTrust()).root, message }), // hooks run -> trust required
  'trust.get.v1': async () => ({ trusted: await trust.isTrusted(needWs().root) }),
  'trust.set.v1': async ({ trusted: t }) => { const ws = needWs(); await trust.set(ws.root, t); if (!t) { killAllPtys(); await lsp.stopAll(); await lsp.setWorkspace(ws.root); } return { trusted: t }; },
  'lsp.status.v1': async () => lsp.status(),
  'lsp.logs.v1': async ({ serverId }) => [...lsp.logs(serverId)],
  'lsp.restart.v1': async ({ serverId }) => { await requireTrust(); await lsp.restart(serverId); return null; },
  'lsp.stop.v1': async ({ serverId }) => { await lsp.stop(serverId); return null; },
  'lsp.install.v1': async ({ serverId }) => {
    const def = Object.values(SERVERS).find((d) => d.id === serverId);
    if (!def) throw new AppError('NOT_FOUND', 'Unknown server');
    const note = (message: string, extra: { done?: boolean; error?: boolean } = {}) => emit('lsp.install.v1', { serverId, message, ...extra });
    void installServer(def, serversDir(), (u) => net.fetch(u as string), note)
      .then(() => { note('Installed', { done: true }); void lsp.restart(serverId).catch(() => {}); })
      .catch((e) => note(`Install failed: ${e instanceof Error ? e.message : e}`, { done: true, error: true }));
    return null;
  },
  'lsp.open.v1': async ({ languageId, uri, version, text }) => { needWs(); await lsp.didOpen(languageId, uri, version, text); return null; },
  'lsp.change.v1': async ({ languageId, uri, version, changes }) => { lsp.didChange(languageId, uri, version, changes); return null; },
  'lsp.save.v1': async ({ languageId, uri }) => { lsp.didSave(languageId, uri); return null; },
  'lsp.close.v1': async ({ languageId, uri }) => { lsp.didClose(languageId, uri); return null; },
  'lsp.request.v1': async ({ languageId, reqId, method, params }) => {
    try { return (await lsp.request(languageId, reqId, method, params, method === 'textDocument/formatting' || method === 'textDocument/rename' || method === 'textDocument/references' ? 30_000 : 15_000)) ?? null; }
    catch (e) { if (e instanceof LspRequestError) throw new AppError('LSP_ERROR', `${e.code}: ${e.message}`); throw e; }
  },
  'lsp.cancel.v1': async ({ reqId }) => { lsp.cancel(reqId); return null; },
  'jdk.list.v1': async () => {
    const g = (await store.getSettings()).javaHome;
    const w = workspace ? (await wsSettings.get(workspace.root)).javaHome : null;
    const extra = [g, w].filter((x): x is string => !!x);
    const eff = workspace ? await jdkFor(workspace.root, 0) : null;
    return { jdks: await discoverJdks(extra), globalHome: g, workspaceHome: w, effective: eff?.home ?? null };
  },
  'jdk.select.v1': async ({ home, scope }) => {
    if (home && !(await probeJdk(home, 'selected'))) throw new AppError('NOT_FOUND', `Not a JDK (missing bin/java or release file): ${home}`);
    if (scope === 'global') await store.updateSettings({ javaHome: home });
    else await wsSettings.set(needWs().root, { javaHome: home });
    if (workspace) for (const id of Object.keys(SERVERS)) if ((await lsp.status()).find((x) => x.id === id && x.state !== 'stopped' && x.state !== 'blocked')) await lsp.restart(id);
    return null;
  },
  'recent.list.v1': async () => store.listRecent(),
  'settings.get.v1': async () => store.getSettings(),
  'settings.update.v1': async (patch) => store.updateSettings(patch),
};

ipcMain.handle('nova:invoke', async (event, channel: unknown, payload: unknown): Promise<Envelope<unknown>> => {
  if (event.sender !== win?.webContents) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown sender' } };
  if (!isChannel(channel)) return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: String(channel) } };
  const spec = channels[channel];
  const req = spec.req.safeParse(payload ?? {});
  if (!req.success) return { ok: false, error: { code: 'INVALID_REQUEST', message: req.error.message } };
  try {
    const result = await (handlers[channel] as (r: unknown) => Promise<unknown>)(req.data);
    return { ok: true, result: spec.res.parse(result) };
  } catch (e) {
    const code: ErrorCode = e instanceof AppError || e instanceof PathError || e instanceof FsError || e instanceof ExistsError || e instanceof TrashError || e instanceof DaemonError ? e.code : 'INTERNAL';
    return { ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
  }
});

function buildMenu() {
  const send = (cmd: string) => () => win?.webContents.send('nova:menu', cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: send('workspace.openFolder') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('file.save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('file.saveAs') },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: send('workbench.commandPalette') },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('workbench.toggleSidebar') },
      { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: send('workbench.togglePanel') },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ] },
  ]));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 480,
    backgroundColor: '#0B0F1E', title: 'DHeaven Code: NOVA', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      webviewTag: false, spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(devUrl ?? 'nova://')) e.preventDefault(); });
  await win.loadURL(devUrl ?? 'nova://app/index.html');
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  trust = new TrustStore(app.getPath('userData'));
  wsSettings = new WorkspaceSettingsStore(app.getPath('userData'));
  daemon = new DaemonClient(daemonPath(), (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === 'search.matches') emit('search.matches.v1', p as unknown as Events['search.matches.v1']);
    else if (method === 'search.done') { searches.delete(p.searchId as number); emit('search.done.v1', p as unknown as Events['search.done.v1']); }
    else if (method === 'pty.data' && ptys.has(p.ptyId as number)) emit('terminal.data.v1', p as unknown as Events['terminal.data.v1']);
    else if (method === 'pty.exit') { ptys.delete(p.ptyId as number); emit('terminal.exit.v1', p as unknown as Events['terminal.exit.v1']); }
  }, (state, message) => {
    if (state === 'restarting') { for (const id of ptys) emit('terminal.exit.v1', { ptyId: id, code: null }); ptys.clear(); }
    emit('daemon.status.v1', message ? { state, message } : { state });
  });
  daemon.start();
  lsp = new LspManager({
    serversDir: serversDir(), storageDir: path.join(app.getPath('userData'), 'lsp'),
    isTrusted: (root) => trust.isTrusted(root), jdkFor, emit: (n, p) => emit(n, p as never),
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  protocol.handle('nova', async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.join(rendererDir, decodeURIComponent(pathname));
    try { assertWithin(rendererDir, file); } catch { return new Response('Forbidden', { status: 403 }); }
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
    return new Response(res.body, { status: res.status, headers });
  });
  buildMenu();
  await createWindow();
});
app.on('window-all-closed', () => { watcher?.stop(); daemon?.stop(); void lsp?.stopAll().finally(() => app.quit()); });
