import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../atomicWrite';

export interface HistoryEntry { id: string; at: string; role: 'user' | 'assistant'; action: string; content: string; provider: string; model: string; error?: string }
const MAX = 200;
/** AI conversation history, one file per workspace (keyed by a hash of the workspace root). */
export class AiHistory {
  constructor(private dir: string) {}
  private file(root: string) { return path.join(this.dir, `${crypto.createHash('sha256').update(root).digest('hex').slice(0, 32)}.json`); }
  async list(root: string): Promise<HistoryEntry[]> { try { return JSON.parse(await fs.readFile(this.file(root), 'utf8')) as HistoryEntry[]; } catch { return []; } }
  async append(root: string, ...e: HistoryEntry[]) {
    const all = [...(await this.list(root)), ...e].slice(-MAX);
    await fs.mkdir(this.dir, { recursive: true }); await atomicWrite(this.file(root), JSON.stringify(all));
  }
  async clear(root: string) { await fs.rm(this.file(root), { force: true }); }
}
