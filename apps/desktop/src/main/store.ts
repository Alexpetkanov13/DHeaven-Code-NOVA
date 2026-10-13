import fs from 'node:fs/promises';
import path from 'node:path';
import { RecentEntry, SessionState, Settings, SettingsPatch } from '@nova/ipc-contract';
import crypto from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from './atomicWrite';

const MAX_RECENT = 15;

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** JSON-backed persistence for settings and recent workspaces in the app's userData dir. */
export class Store {
  constructor(private dir: string) {}
  private get settingsFile() { return path.join(this.dir, 'settings.json'); }
  private get recentFile() { return path.join(this.dir, 'recent.json'); }

  async getSettings(): Promise<Settings> {
    const parsed = Settings.safeParse((await readJson(this.settingsFile)) ?? {});
    return parsed.success ? parsed.data : Settings.parse({});
  }
  async updateSettings(patch: z.input<typeof SettingsPatch>): Promise<Settings> {
    const next = Settings.parse({ ...(await this.getSettings()), ...SettingsPatch.parse(patch) });
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.settingsFile, JSON.stringify(next, null, 2));
    return next;
  }
  /** Main-only: lspServerPaths is not part of SettingsPatch, so a renderer settings update cannot point NOVA at an arbitrary executable. */
  async setLspServerPath(serverId: string, exe: string | null): Promise<Settings> {
    const cur = await this.getSettings();
    const paths = { ...cur.lspServerPaths };
    if (exe) paths[serverId] = exe; else delete paths[serverId];
    const next = Settings.parse({ ...cur, lspServerPaths: paths });
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.settingsFile, JSON.stringify(next, null, 2));
    return next;
  }
  /** Main-only (not in SettingsPatch), chosen through a native file picker. */
  async setDebugAdapterPath(id: string, file: string | null): Promise<Settings> {
    const cur = await this.getSettings();
    const paths = { ...cur.debugAdapterPaths };
    if (file) paths[id] = file; else delete paths[id];
    const next = Settings.parse({ ...cur, debugAdapterPaths: paths });
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.settingsFile, JSON.stringify(next, null, 2));
    return next;
  }
  async listRecent(): Promise<RecentEntry[]> {
    const parsed = z.array(RecentEntry).safeParse(await readJson(this.recentFile));
    return parsed.success ? parsed.data : [];
  }
  async addRecent(root: string, name: string, now = Date.now()): Promise<RecentEntry[]> {
    const list = [{ root, name, openedAt: now }, ...(await this.listRecent()).filter((r) => r.root !== root)].slice(0, MAX_RECENT);
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.recentFile, JSON.stringify(list, null, 2));
    return list;
  }
  private sessionFile(root: string) { return path.join(this.dir, 'sessions', `${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}.json`); }
  async getSession(root: string): Promise<SessionState | null> {
    const raw = (await readJson(this.sessionFile(root))) as { root?: string; state?: unknown } | undefined;
    if (!raw || raw.root !== root) return null;
    const parsed = SessionState.safeParse(raw.state);
    return parsed.success ? parsed.data : null;
  }
  /** Drafts above a total of 32 MB are dropped (largest first) so a session file stays bounded. */
  async saveSession(root: string, state: SessionState): Promise<void> {
    const drafts = [...state.drafts].sort((a, b) => a.content.length - b.content.length);
    let total = 0; const kept = drafts.filter((d) => (total += d.content.length) <= 32 * 1024 * 1024);
    await fs.mkdir(path.dirname(this.sessionFile(root)), { recursive: true });
    await atomicWrite(this.sessionFile(root), JSON.stringify({ root, state: { ...state, drafts: kept } }));
  }
  /** The most recently opened workspace, if its folder still exists. */
  async lastWorkspace(): Promise<string | null> {
    const r = (await this.listRecent())[0];
    if (!r) return null;
    return (await fs.stat(r.root).then((s) => s.isDirectory(), () => false)) ? r.root : null;
  }
}
