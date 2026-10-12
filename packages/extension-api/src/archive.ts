import { createHash } from 'node:crypto';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { MANIFEST_FILE, validateManifest, type Manifest } from './manifest';

export const INTEGRITY_FILE = '.nova/integrity.json';
export const LIMITS = { maxEntries: 2000, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024, maxArchiveBytes: 50 * 1024 * 1024 };
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Rejects zip-slip and other hostile entry names. Returns the normalised path or throws. */
export function safeEntryPath(name: string): string {
  if (name.includes('\0')) throw new Error(`unsafe entry name (NUL): ${JSON.stringify(name)}`);
  if (name.includes('\\')) throw new Error(`unsafe entry name (backslash): ${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('//')) throw new Error(`unsafe entry name (absolute): ${name}`);
  const parts = name.split('/');
  if (parts.some((p) => p === '..')) throw new Error(`unsafe entry name (path traversal): ${name}`);
  const clean = parts.filter((p) => p !== '' && p !== '.');
  if (!clean.length) throw new Error(`empty entry name: ${name}`);
  for (const p of clean) {
    if (/[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p)) throw new Error(`unsafe entry name (not portable): ${name}`);
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p)) throw new Error(`unsafe entry name (reserved on Windows): ${name}`);
  }
  return clean.join('/');
}

export interface ReadArchiveResult { manifest: Manifest; files: Map<string, Uint8Array>; archiveSha256: string; warnings: string[] }

/** Safely reads a .novaext archive in memory: name checks, size/count limits, per-file SHA-256 integrity, manifest validation. */
export function readArchive(data: Uint8Array, novaVersion?: string, limits = LIMITS): ReadArchiveResult {
  if (data.length > limits.maxArchiveBytes) throw new Error(`archive too large (${data.length} bytes)`);
  let count = 0; let declaredTotal = 0;
  const seen = new Set<string>();
  const raw = unzipSync(data, {
    filter: (f) => {
      if (f.name.endsWith('/')) { safeEntryPath(f.name); return false; }
      if (++count > limits.maxEntries) throw new Error('too many entries');
      const p = safeEntryPath(f.name);
      const key = p.toLowerCase();
      if (seen.has(key)) throw new Error(`duplicate entry (case-insensitive): ${p}`);
      seen.add(key);
      if (f.originalSize > limits.maxFileBytes) throw new Error(`entry too large: ${p}`);
      declaredTotal += f.originalSize;
      if (declaredTotal > limits.maxTotalBytes) throw new Error('archive expands too large');
      return true;
    },
  });
  const files = new Map<string, Uint8Array>(); let total = 0;
  for (const [name, bytes] of Object.entries(raw)) {
    total += bytes.length; // real sizes: headers can lie
    if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes) throw new Error('archive expands too large');
    files.set(safeEntryPath(name), bytes);
  }
  const integrityRaw = files.get(INTEGRITY_FILE);
  if (!integrityRaw) throw new Error(`missing ${INTEGRITY_FILE} (pack with nova-ext)`);
  let integrity: { algorithm: string; files: Record<string, string> };
  try { integrity = JSON.parse(new TextDecoder().decode(integrityRaw)); } catch { throw new Error(`${INTEGRITY_FILE} is not valid JSON`); }
  if (integrity.algorithm !== 'sha256' || typeof integrity.files !== 'object' || !integrity.files) throw new Error(`${INTEGRITY_FILE}: unsupported format`);
  const listed = new Set(Object.keys(integrity.files));
  for (const [p, b] of files) {
    if (p === INTEGRITY_FILE) continue;
    if (!listed.has(p)) throw new Error(`integrity: file not listed: ${p}`);
    if (sha256(b) !== integrity.files[p]) throw new Error(`integrity: SHA-256 mismatch for ${p}`);
    listed.delete(p);
  }
  if (listed.size) throw new Error(`integrity: missing files: ${[...listed].join(', ')}`);
  const mf = files.get(MANIFEST_FILE);
  if (!mf) throw new Error(`missing ${MANIFEST_FILE} at the archive root`);
  let json: unknown; try { json = JSON.parse(new TextDecoder().decode(mf)); } catch { throw new Error(`${MANIFEST_FILE} is not valid JSON`); }
  const v = validateManifest(json, novaVersion);
  if (!v.ok) throw new Error(`invalid manifest:\n  ${v.errors.join('\n  ')}`);
  checkReferencedFiles(v.manifest, (p) => files.has(p));
  return { manifest: v.manifest, files, archiveSha256: sha256(data), warnings: v.warnings };
}

/** Every path the manifest references must exist in the package. */
export function checkReferencedFiles(m: Manifest, exists: (p: string) => boolean) {
  const refs = [m.main, ...m.contributes.themes.map((t) => t.path), ...m.contributes.grammars.map((g) => g.path), ...m.contributes.snippets.map((s) => s.path), ...m.contributes.languages.map((l) => l.configuration)].filter((x): x is string => !!x);
  const missing = refs.filter((r) => !exists(r));
  if (missing.length) throw new Error(`manifest references missing files: ${missing.join(', ')}`);
}

/** Builds a .novaext from an in-memory file map (paths relative, '/'-separated). Adds the integrity file. */
export function packFiles(files: Map<string, Uint8Array>, novaVersion?: string): { data: Uint8Array; manifest: Manifest; sha256: string } {
  const mf = files.get(MANIFEST_FILE); if (!mf) throw new Error(`missing ${MANIFEST_FILE}`);
  const v = validateManifest(JSON.parse(new TextDecoder().decode(mf)), novaVersion);
  if (!v.ok) throw new Error(`invalid manifest:\n  ${v.errors.join('\n  ')}`);
  checkReferencedFiles(v.manifest, (p) => files.has(p));
  const z: Zippable = {}; const integrity: Record<string, string> = {};
  for (const [p, b] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const sp = safeEntryPath(p); if (sp === INTEGRITY_FILE) continue;
    z[sp] = [b, { mtime: new Date('2000-01-01T00:00:00Z') }]; integrity[sp] = sha256(b);
  }
  z[INTEGRITY_FILE] = [new TextEncoder().encode(JSON.stringify({ algorithm: 'sha256', files: integrity }, null, 2)), { mtime: new Date('2000-01-01T00:00:00Z') }];
  const data = zipSync(z, { level: 6 });
  return { data, manifest: v.manifest, sha256: sha256(data) };
}
