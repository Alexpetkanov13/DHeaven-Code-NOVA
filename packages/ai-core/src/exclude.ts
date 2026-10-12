import ignore from 'ignore';

export const MAX_CONTEXT_FILE_BYTES = 100 * 1024;
const SENSITIVE_NAME = [
  /^\.env(\..*)?$/i, /^.*\.env$/i, /^\.envrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^\.pgpass$/i, /^\.git-credentials$/i, /^\.dockercfg$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ovpn|crt|cer|der)$/i,
  /^(credentials|secrets?)(\..*)?$/i, /^.*secrets?\.(json|ya?ml|toml|ini|txt)$/i, /^service[-_]?account.*\.json$/i, /^terraform\.tfstate(\.backup)?$/i, /^htpasswd$|^\.htpasswd$/i,
];
const SENSITIVE_DIR = /(^|\/)(\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|node_modules)(\/|$)/i;

export type ExclusionReason = 'sensitive' | 'ignored' | 'binary' | 'oversized';
/** Name/path based check (no I/O). */
export function sensitiveReason(rel: string): string | null {
  const p = rel.replace(/\\/g, '/');
  if (SENSITIVE_DIR.test(p)) return `inside ${SENSITIVE_DIR.exec(p)![2]}`;
  const name = p.split('/').pop() ?? p;
  for (const r of SENSITIVE_NAME) if (r.test(name)) return `sensitive file name (${name})`;
  return null;
}
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
/** gitignore matcher from the workspace's root .gitignore contents (plus extra patterns). */
export function ignoreMatcher(gitignore: string | null, extra: string[] = []) {
  const ig = ignore().add(gitignore ?? '').add(extra);
  return (rel: string) => { try { return ig.ignores(rel.replace(/\\/g, '/')); } catch { return false; } };
}
/** Decides whether a file may be included in AI context. */
export function classifyFile(rel: string, bytes: Uint8Array | null, ignored: (rel: string) => boolean): { ok: true } | { ok: false; reason: ExclusionReason; detail: string } {
  const s = sensitiveReason(rel); if (s) return { ok: false, reason: 'sensitive', detail: s };
  if (ignored(rel)) return { ok: false, reason: 'ignored', detail: 'matched .gitignore / AI ignore list' };
  if (bytes) {
    if (bytes.length > MAX_CONTEXT_FILE_BYTES) return { ok: false, reason: 'oversized', detail: `${bytes.length} bytes > ${MAX_CONTEXT_FILE_BYTES}` };
    if (isBinary(bytes)) return { ok: false, reason: 'binary', detail: 'contains NUL bytes' };
  }
  return { ok: true };
}
