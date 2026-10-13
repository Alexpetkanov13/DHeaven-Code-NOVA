import { renameRetry } from './fsRetry';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
export async function atomicWrite(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.nova-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode;
  } catch {
    /* new file */
  }
  const fh = await fs.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameRetry(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
