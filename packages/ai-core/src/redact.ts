/** Secret redaction applied to every piece of workspace/terminal text before it can leave the machine. */
export interface Redaction { kind: string; count: number }
const RULES: { kind: string; re: RegExp; keep?: (m: string, ...g: string[]) => string }[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, keep: (_m, p) => `${p}[REDACTED:bearer]` },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, keep: (_m, p) => `${p}[REDACTED:password]@` },
  // KEY=value / "password": "value" style assignments of secret-looking names.
  { kind: 'assignment', re: /((?:^|[\s,{;(])["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})\2/gim, keep: (_m, p, q) => `${p}${q}[REDACTED:secret]${q}` },
];

export function redactSecrets(text: string): { text: string; redactions: Redaction[] } {
  const counts = new Map<string, number>();
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...a: string[]) => {
      const m = a[0]!;
      if (m.includes('[REDACTED:')) return m;
      counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      return r.keep ? r.keep(m, ...(a.slice(1) as string[])) : `[REDACTED:${r.kind}]`;
    });
  }
  return { text: out, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}
