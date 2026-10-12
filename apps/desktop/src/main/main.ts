import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { channels, isChannel, type Envelope, type ErrorCode, type WorkspaceInfo } from '@nova/ipc-contract';
import { Store } from './store';
import { listDir, readFile, writeFile, FsError } from './workspaceFs';
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

class AppError extends Error { constructor(public code: ErrorCode, m: string) { super(m); } }

async function openWorkspace(root: string): Promise<WorkspaceInfo> {
  const abs = path.resolve(root);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new AppError('NOT_FOUND', 'Folder does not exist');
  workspace = { root: await fs.realpath(abs), name: path.basename(abs) };
  await store.addRecent(workspace.root, workspace.name);
  win?.setTitle(`${workspace.name} — DHeaven Code: NOVA`);
  return workspace;
}
const needWs = () => { if (!workspace) throw new AppError('NO_WORKSPACE', 'No folder is open'); return workspace; };

type Handlers = { [C in keyof typeof channels]: (req: import('zod').output<(typeof channels)[C]['req']>) => Promise<unknown> };
const handlers: Handlers = {
  'app.info.v1': async () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }),
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
    const code: ErrorCode = e instanceof AppError || e instanceof PathError || e instanceof FsError ? e.code : 'INTERNAL';
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
app.on('window-all-closed', () => app.quit());
