import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Reusable New Project engine. A template is a folder of files; `{{var}}` in text files and `__var__` in path
 * segments are substituted. Template-specific values (versions, JDK requirement) come from a resolver.
 */
export interface TemplateOptions { name: string; modId: string; package: string; author: string; description: string }
export const OPTION_RULES: Record<keyof TemplateOptions, { re: RegExp; hint: string }> = {
  name: { re: /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/, hint: 'letters, digits, space, _ . - (max 64)' },
  modId: { re: /^[a-z][a-z0-9_-]{1,63}$/, hint: 'lowercase, starts with a letter, 2-64 of a-z 0-9 _ -' },
  package: { re: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, hint: 'Java package like com.example.mymod' },
  author: { re: /^[A-Za-z0-9 _.-]{1,64}$/, hint: 'letters, digits, space, _ . - (max 64)' },
  description: { re: /^[^"\\{}$\r\n<>]{0,200}$/, hint: 'no quotes, backslashes, braces, $ or newlines (max 200)' },
};
const JAVA_KEYWORDS = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield'.split(' '));

export function validateOptions(o: TemplateOptions): string[] {
  const errs: string[] = [];
  for (const [k, r] of Object.entries(OPTION_RULES) as [keyof TemplateOptions, { re: RegExp; hint: string }][]) if (typeof o[k] !== 'string' || !r.re.test(o[k])) errs.push(`${k}: ${r.hint}`);
  if (typeof o.package === 'string' && o.package.split('.').some((s) => JAVA_KEYWORDS.has(s))) errs.push('package: contains a Java keyword');
  return errs;
}
export function className(name: string): string {
  const c = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').replace(/^[0-9]+/, '');
  return c && !JAVA_KEYWORDS.has(c.toLowerCase()) ? c : 'MainPlugin';
}

const BINARY = /\.(jar|png|jpg|gif|ico|zip)$/i;
const RENAME: Record<string, string> = { gitignore: '.gitignore' };

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r))); else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (m, k: string) => { if (!(k in vars)) throw new Error(`template variable {{${k}}} has no value`); return vars[k]!; });
}
function mapPath(rel: string, vars: Record<string, string>): string {
  const parts = rel.split('/').flatMap((seg) => {
    const s = seg.replace(/__([A-Za-z][A-Za-z0-9]*)__/g, (m, k: string) => { if (!(k in vars)) throw new Error(`path variable ${m} has no value`); return vars[k]!; });
    return s.split('/');
  });
  const last = parts.length - 1; parts[last] = RENAME[parts[last]!] ?? parts[last]!;
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`unsafe template path: ${rel}`);
  return parts.join('/');
}

/** Renders `templateDir` (+ optional Gradle wrapper dir) into `target`, which must not exist or be empty. Returns created files. */
export async function renderTemplate(templateDir: string, wrapperDir: string | null, target: string, vars: Record<string, string>): Promise<string[]> {
  const existing = await fs.readdir(target).catch(() => null);
  if (existing && existing.length) throw new Error(`Target folder is not empty: ${target}`);
  const sources: { abs: string; rel: string }[] = [];
  for (const [dir, render] of [[templateDir, true], ...(wrapperDir ? [[wrapperDir, false]] : [])] as [string, boolean][])
    for (const r of await walk(dir)) sources.push({ abs: path.join(dir, r), rel: render ? mapPath(r, vars) : r });
  // Render everything in memory first so a bad variable fails before anything is written.
  const files = await Promise.all(sources.map(async (s) => {
    const raw = await fs.readFile(s.abs);
    return { rel: s.rel, data: BINARY.test(s.rel) || s.abs.startsWith(wrapperDir ?? '\0') ? raw : Buffer.from(substitute(raw.toString('utf8'), vars)) };
  }));
  const root = path.resolve(target);
  for (const f of files) {
    const out = path.resolve(root, f.rel);
    if (!out.startsWith(root + path.sep)) throw new Error(`unsafe output path: ${f.rel}`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, f.data, { flag: 'wx' });
    if (/(^|\/)gradlew$/.test(f.rel)) await fs.chmod(out, 0o755);
  }
  return files.map((f) => f.rel);
}
