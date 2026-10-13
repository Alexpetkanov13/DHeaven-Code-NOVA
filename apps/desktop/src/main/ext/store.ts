import { renameRetry, rmRetry } from '../fsRetry';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { MANIFEST_FILE, compare, readArchive, readFolder, packFiles, validateManifest, writeFiles, extensionId, type Manifest, type GrantState } from '@nova/extension-api';
import { atomicWrite } from '../atomicWrite';

const Entry = z.object({
  version: z.string(), enabled: z.boolean(), previous: z.string().nullable().default(null),
  quarantined: z.string().nullable().default(null), // reason; set after a crash/hang the extension caused
  grants: z.record(z.string(), z.enum(['granted', 'denied'])).default({}),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  state: z.record(z.string(), z.unknown()).default({}),
  sha256: z.string(), source: z.string(), installedAt: z.string(),
});
export type StoreEntry = z.infer<typeof Entry>;
const State = z.object({ version: z.literal(1), extensions: z.record(z.string(), Entry) });

export interface InstalledExtension { id: string; dir: string; manifest: Manifest; entry: StoreEntry }
export interface InstallPreview { token: string; id: string; manifest: Manifest; sha256: string; sidecar: 'match' | 'mismatch' | 'none'; source: string; isUpdate: boolean; fromVersion: string | null; warnings: string[]; files: number }

/**
 * Installed extensions live in `<root>/<id>/<version>/`; state in `<root>/state.json` (atomic writes).
 * Install = validate fully in memory, write to a temp dir, rename into place, then switch the state; the previous
 * version stays on disk so it can be rolled back to.
 */
export class ExtensionStore {
  private state: z.infer<typeof State> = { version: 1, extensions: {} };
  private previews = new Map<string, { files: Map<string, Uint8Array>; preview: InstallPreview }>();
  constructor(readonly root: string, private novaVersion: string) {}
  private get file() { return path.join(this.root, 'state.json'); }
  async load() {
    await fs.mkdir(this.root, { recursive: true });
    try { this.state = State.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch { this.state = { version: 1, extensions: {} }; }
  }
  private async save() { await atomicWrite(this.file, JSON.stringify(this.state, null, 2)); }
  dirOf(id: string, version: string) { return path.join(this.root, id, version); }

  async list(): Promise<InstalledExtension[]> {
    const out: InstalledExtension[] = [];
    for (const [id, entry] of Object.entries(this.state.extensions)) {
      const dir = this.dirOf(id, entry.version);
      try {
        const v = validateManifest(JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8')));
        if (v.ok && extensionId(v.manifest) === id) out.push({ id, dir, manifest: v.manifest, entry });
      } catch { /* broken install: skipped (shown nowhere); repaired by reinstall */ }
    }
    return out.sort((a, b) => a.manifest.displayName.localeCompare(b.manifest.displayName));
  }
  get(id: string) { return this.state.extensions[id]; }

  /** Reads + validates a .novaext file or an extension folder, without installing. */
  async inspect(source: string): Promise<InstallPreview> {
    const st = await fs.stat(source);
    let files: Map<string, Uint8Array>; let sha: string; let sidecar: InstallPreview['sidecar'] = 'none'; let warnings: string[] = []; let manifest: Manifest;
    if (st.isDirectory()) {
      files = await readFolder(source);
      const p = packFiles(files, this.novaVersion); manifest = p.manifest;
      const r = readArchive(p.data, this.novaVersion); files = r.files; warnings = r.warnings; sha = r.archiveSha256;
    } else {
      const data = await fs.readFile(source);
      const r = readArchive(data, this.novaVersion); files = r.files; manifest = r.manifest; warnings = r.warnings; sha = r.archiveSha256;
      try {
        const want = (await fs.readFile(`${source}.sha256`, 'utf8')).trim().split(/\s+/)[0]!.toLowerCase();
        sidecar = want === sha ? 'match' : 'mismatch';
      } catch { sidecar = 'none'; }
      if (sidecar === 'mismatch') throw new Error(`SHA-256 of ${path.basename(source)} (${sha}) does not match ${path.basename(source)}.sha256 — refusing to install`);
    }
    const id = extensionId(manifest);
    const cur = this.state.extensions[id];
    const token = crypto.randomBytes(16).toString('hex');
    const preview: InstallPreview = { token, id, manifest, sha256: sha, sidecar, source, isUpdate: !!cur, fromVersion: cur?.version ?? null, warnings, files: files.size };
    this.previews.clear(); this.previews.set(token, { files, preview });
    return preview;
  }

  previewId(token: string) { return this.previews.get(token)?.preview.id ?? null; }
  cancel(token: string) { this.previews.delete(token); }
  async commit(token: string): Promise<InstalledExtension> {
    const p = this.previews.get(token); if (!p) throw new Error('Install request expired; choose the file again');
    this.previews.delete(token);
    const { id, manifest, sha256, source } = p.preview;
    const cur = this.state.extensions[id];
    const final = this.dirOf(id, manifest.version);
    const tmp = path.join(this.root, id, `.tmp-${manifest.version}-${Date.now()}`);
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    try { await writeFiles(tmp, p.files); } catch (e) { await rmRetry(tmp); throw e; }
    let backup: string | null = null;
    if (await fs.stat(final).then(() => true, () => false)) { backup = `${final}.bak-${Date.now()}`; await renameRetry(final, backup); } // reinstall same version
    try { await renameRetry(tmp, final); } catch (e) { if (backup) await renameRetry(backup, final); await rmRetry(tmp); throw e; }
    const previous = cur && cur.version !== manifest.version ? cur.version : cur?.previous ?? null;
    this.state.extensions[id] = {
      version: manifest.version, enabled: cur?.enabled ?? true, previous, quarantined: null, grants: cur?.grants ?? {}, config: cur?.config ?? {}, state: cur?.state ?? {},
      sha256, source, installedAt: new Date().toISOString(),
    };
    try { await this.save(); } catch (e) { // roll back on-disk switch
      if (cur) this.state.extensions[id] = cur; else delete this.state.extensions[id];
      await rmRetry(final); if (backup) await renameRetry(backup, final); throw e;
    }
    if (backup) await rmRetry(backup);
    await this.gc(id);
    return { id, dir: final, manifest, entry: this.state.extensions[id]! };
  }

  /** Swap to the previous version (kept on disk by the last update). */
  async rollback(id: string) {
    const e = this.state.extensions[id]; if (!e?.previous) throw new Error('No previous version to roll back to');
    const prevDir = this.dirOf(id, e.previous);
    const v = validateManifest(JSON.parse(await fs.readFile(path.join(prevDir, MANIFEST_FILE), 'utf8')), this.novaVersion);
    if (!v.ok) throw new Error(`Previous version is not usable: ${v.errors.join('; ')}`);
    const cur = e.version; e.version = e.previous; e.previous = cur; e.quarantined = null;
    await this.save();
    return { id, dir: prevDir, manifest: v.manifest, entry: e } as InstalledExtension;
  }
  /** Keep only the current and previous version directories. */
  private async gc(id: string) {
    const e = this.state.extensions[id]; if (!e) return;
    const keep = new Set([e.version, e.previous].filter(Boolean) as string[]);
    for (const d of await fs.readdir(path.join(this.root, id)).catch(() => [] as string[])) if (!keep.has(d)) await rmRetry(path.join(this.root, id, d));
  }
  async uninstall(id: string) {
    if (!this.state.extensions[id]) throw new Error(`Not installed: ${id}`);
    delete this.state.extensions[id]; await this.save();
    await rmRetry(path.join(this.root, id));
  }
  async update(id: string, patch: Partial<Pick<StoreEntry, 'enabled' | 'quarantined' | 'grants' | 'config' | 'state'>>) {
    const e = this.state.extensions[id]; if (!e) throw new Error(`Not installed: ${id}`);
    Object.assign(e, patch); await this.save();
  }
  setGrant(id: string, perm: string, g: GrantState | null) {
    const e = this.state.extensions[id]; if (!e) throw new Error(`Not installed: ${id}`);
    const grants = { ...e.grants }; if (g) grants[perm] = g; else delete grants[perm];
    return this.update(id, { grants });
  }
  newer(a: string, b: string) { return compare(a, b) > 0; }
}
