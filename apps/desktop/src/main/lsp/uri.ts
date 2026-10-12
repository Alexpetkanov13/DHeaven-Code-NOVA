import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Canonical file URI used everywhere in NOVA (matches monaco.Uri.file(...).toString()):
 * lowercase drive letter, ':' percent-encoded as %3A, forward slashes, no trailing slash.
 */
export function canonicalUri(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  let p: string;
  try { p = fileURLToPath(uri.replace(/%3A/gi, ':')); } catch { return uri; }
  return fileUri(p);
}

export function fileUri(absPath: string): string {
  let p = absPath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p)) p = '/' + p[0]!.toLowerCase() + p.slice(1);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return 'file://' + p.split('/').map((seg) => encodeURIComponent(seg)).join('/').replace(/^\/([a-z])%3A/, '/$1%3A');
}

/** URI for sending to servers (standard Node form, e.g. file:///C:/x). */
export function serverUri(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  return pathToFileURL(uriToPath(uri)).toString();
}

export function uriToPath(uri: string): string {
  const p = fileURLToPath(uri.replace(/%3A/gi, ':'));
  return path.normalize(p);
}

/** Deep-walks a JSON value and canonicalizes every string that is a file URI (keys "uri"/"targetUri"/... or WorkspaceEdit.changes keys). */
export function mapUris<T>(v: T, fn: (u: string) => string): T {
  if (typeof v === 'string') return (v.startsWith('file:') ? fn(v) : v) as T;
  if (Array.isArray(v)) return v.map((x) => mapUris(x, fn)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k.startsWith('file:') ? fn(k) : k] = mapUris(x, fn);
    return o as T;
  }
  return v;
}
