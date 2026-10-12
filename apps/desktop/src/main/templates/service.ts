import path from 'node:path';
import fs from 'node:fs/promises';
import { className, renderTemplate, validateOptions, type TemplateOptions } from './engine';
import { resolveFor, type Fetch, type Resolution } from './resolvers';

export interface TemplateSource { key: string; extId: string; extName: string; id: string; label: string; description: string; dir: string; wrapperDir: string | null; resolver: string }
export interface GenerateRequest { key: string; options: TemplateOptions; minecraft: string | null; parentDir: string; folderName: string }

/** Lists contributed templates, resolves versions (cached per resolver so generation uses exactly what was shown), renders. */
export class TemplateService {
  private cache = new Map<string, Resolution>();
  constructor(private d: { templates(): Promise<TemplateSource[]>; fetch: Fetch }) {}
  async list() { return (await this.d.templates()).map((t) => ({ key: t.key, extId: t.extId, extName: t.extName, id: t.id, label: t.label, description: t.description, resolver: t.resolver })); }
  async resolve(key: string, refresh = false): Promise<Resolution> {
    const t = await this.find(key);
    if (!refresh && this.cache.has(t.resolver)) return this.cache.get(t.resolver)!;
    const r = await resolveFor(t.resolver, this.d.fetch);
    this.cache.set(t.resolver, r); return r;
  }
  private async find(key: string) { const t = (await this.d.templates()).find((x) => x.key === key); if (!t) throw new Error(`Unknown template: ${key}`); return t; }

  async generate(req: GenerateRequest): Promise<{ root: string; files: string[]; javaMajor: number | null; resolution: Resolution }> {
    const t = await this.find(req.key);
    const errs = validateOptions(req.options);
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(req.folderName)) errs.push('folder: letters, digits, space, _ . -');
    if (!path.isAbsolute(req.parentDir)) errs.push('location: must be an absolute folder');
    if (errs.length) throw new Error(errs.join('; '));
    const res = await this.resolve(req.key);
    const v = res.versions.find((x) => x.minecraft === req.minecraft);
    if (res.versions.length && !v) throw new Error(`Minecraft ${req.minecraft} is not one of the resolved versions`);
    if (!(await fs.stat(req.parentDir).then((s) => s.isDirectory(), () => false))) throw new Error(`Location does not exist: ${req.parentDir}`);
    const root = path.join(req.parentDir, req.folderName);
    const vars: Record<string, string> = {
      ...req.options, className: className(req.options.name), packagePath: req.options.package.replace(/\./g, '/'),
      minecraftVersion: v?.minecraft ?? '', javaVersion: String(v?.javaMajor ?? 21),
      versionSource: res.source === 'live' ? `versions resolved live on ${new Date().toISOString().slice(0, 10)}` : res.note,
      ...res.shared, ...(v?.deps ?? {}),
    };
    const files = await renderTemplate(t.dir, t.wrapperDir, root, vars);
    return { root, files, javaMajor: v?.javaMajor ?? null, resolution: res };
  }
}
