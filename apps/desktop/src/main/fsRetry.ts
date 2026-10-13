import fs from 'node:fs/promises';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** fs.rename that retries transient Windows errors (Defender/indexer briefly holding freshly written files). */
export async function renameRetry(from: string, to: string, attempts = process.platform === 'win32' ? 12 : 1): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await fs.rename(from, to); }
    catch (e) {
      if (i + 1 >= attempts || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** i, 1000)));
    }
  }
}

/** Recursive force rm with Node's built-in EBUSY/EPERM retry loop (needed on Windows). */
export const rmRetry = (p: string) => fs.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
