import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../atomicWrite';

/** Subset of Electron's safeStorage (injectable for tests). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/**
 * API keys encrypted with the OS keychain via Electron safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux). Refuses to store a key when only Chromium's hard-coded "basic_text" fallback
 * is available, because that is equivalent to plaintext. Keys never leave the main process.
 */
export class KeyStore {
  constructor(private dir: string, private cipher: SecretCipher) {}
  private get file() { return path.join(this.dir, 'ai-keys.json'); }
  status(): { available: boolean; backend: string; reason: string | null } {
    const backend = this.cipher.getSelectedStorageBackend?.() ?? (process.platform === 'linux' ? 'unknown' : 'os');
    if (!this.cipher.isEncryptionAvailable()) return { available: false, backend, reason: 'OS keychain encryption is not available' };
    if (backend === 'basic_text') return { available: false, backend, reason: 'No OS keyring (libsecret/kwallet) found; Electron would fall back to an obfuscated plaintext key' };
    return { available: true, backend, reason: null };
  }
  private async read(): Promise<Record<string, string>> {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, string>; } catch { return {}; }
  }
  async has(id: string) { return id in (await this.read()); }
  async set(id: string, key: string | null) {
    const all = await this.read();
    if (key === null) delete all[id];
    else {
      const st = this.status(); if (!st.available) throw new Error(`Cannot store API key securely: ${st.reason}`);
      all[id] = this.cipher.encryptString(key).toString('base64');
    }
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.file, JSON.stringify(all));
  }
  async get(id: string): Promise<string | null> {
    const v = (await this.read())[id]; if (!v) return null;
    return this.cipher.decryptString(Buffer.from(v, 'base64'));
  }
}
