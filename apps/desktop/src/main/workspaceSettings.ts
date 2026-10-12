import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './atomicWrite';

const WsSettings = z.object({ javaHome: z.string().nullable().default(null) });
export type WsSettings = z.infer<typeof WsSettings>;

/** Per-workspace overrides kept in userData (never written into the user's repository). */
export class WorkspaceSettingsStore {
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, 'workspace-settings.json'); }
  private async all(): Promise<Record<string, WsSettings>> {
    try { return z.record(z.string(), WsSettings).parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch { return {}; }
  }
  async get(root: string): Promise<WsSettings> { return (await this.all())[path.resolve(root)] ?? WsSettings.parse({}); }
  async set(root: string, patch: Partial<WsSettings>) {
    const all = await this.all();
    all[path.resolve(root)] = WsSettings.parse({ ...(all[path.resolve(root)] ?? {}), ...patch });
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.file, JSON.stringify(all, null, 2));
  }
}
