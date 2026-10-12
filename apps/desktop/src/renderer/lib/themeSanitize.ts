/** Pure (no Monaco import) so it can be unit-tested. */
export interface TokenRule { token: string; foreground?: string; background?: string; fontStyle?: string }
/** Workbench CSS variables an extension theme may set; values must be plain hex colours. */
export const THEMABLE_VARS = ['nova-graphite-900', 'nova-graphite-800', 'nova-navy-900', 'nova-navy-700', 'nova-ultraviolet-800', 'nova-border', 'nova-cyan', 'nova-violet', 'nova-text', 'nova-text-dim', 'nova-danger'] as const;
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const HEX_NOHASH = /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const COLOR_KEY = /^[A-Za-z0-9.]{1,80}$/;

export interface SanitizedTheme { base: 'vs' | 'vs-dark' | 'hc-black'; rules: TokenRule[]; colors: Record<string, string>; vars: Record<string, string>; dropped: number }
/** Theme JSON comes from an extension: keep only well-formed colours and allowlisted CSS variables. */
export function sanitizeTheme(data: unknown, uiTheme: string): SanitizedTheme {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  let dropped = 0;
  const colors: Record<string, string> = {}; const vars: Record<string, string> = {}; const rules: TokenRule[] = [];
  for (const [k, v] of Object.entries((d.colors ?? {}) as Record<string, unknown>).slice(0, 500)) { if (COLOR_KEY.test(k) && typeof v === 'string' && HEX.test(v)) colors[k] = v; else dropped++; }
  for (const r of (Array.isArray(d.tokenColors) ? d.tokenColors : []).slice(0, 500) as Record<string, unknown>[]) {
    if (!r || typeof r.token !== 'string' || !/^[A-Za-z0-9.\-_]{0,80}$/.test(r.token)) { dropped++; continue; }
    const rule: TokenRule = { token: r.token };
    if (typeof r.foreground === 'string' && HEX_NOHASH.test(r.foreground.replace(/^#/, ''))) rule.foreground = r.foreground.replace(/^#/, '');
    if (typeof r.background === 'string' && HEX_NOHASH.test(r.background.replace(/^#/, ''))) rule.background = r.background.replace(/^#/, '');
    if (typeof r.fontStyle === 'string' && /^((italic|bold|underline)\s*){0,3}$/.test(r.fontStyle)) rule.fontStyle = r.fontStyle;
    rules.push(rule);
  }
  for (const [k, v] of Object.entries((d.workbench ?? {}) as Record<string, unknown>)) { if ((THEMABLE_VARS as readonly string[]).includes(k) && typeof v === 'string' && HEX.test(v)) vars[k] = v; else dropped++; }
  return { base: uiTheme === 'light' ? 'vs' : uiTheme === 'hc' ? 'hc-black' : 'vs-dark', rules, colors, vars, dropped };
}
