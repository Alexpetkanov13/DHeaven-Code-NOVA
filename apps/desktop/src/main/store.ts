import fs from 'node:fs/promises';
import path from 'node:path';
import { RecentEntry, Settings, SettingsPatch } from '@nova/ipc-contract';
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
}
