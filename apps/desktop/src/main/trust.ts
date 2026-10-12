import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './atomicWrite';

/** Workspace trust (ADR-0008). Trusted roots stored in userData/trust.json. */
export class TrustStore {
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, 'trust.json'); }
  private async list(): Promise<string[]> {
    try { return z.array(z.string()).parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch { return []; }
  }
  async isTrusted(root: string) {
    const r = path.resolve(root);
    return (await this.list()).some((t) => r === t || r.startsWith(t + path.sep));
  }
  async set(root: string, trusted: boolean) {
    const r = path.resolve(root);
    const rest = (await this.list()).filter((t) => t !== r);
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.file, JSON.stringify(trusted ? [...rest, r] : rest, null, 2));
  }
}
