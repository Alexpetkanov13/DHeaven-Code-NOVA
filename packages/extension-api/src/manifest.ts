import { z } from 'zod';
import { PERMISSION_IDS } from './permissions';
import { SEMVER_RE, satisfies, validRange } from './semver';

export const MANIFEST_FILE = 'nova-extension.json';
const ID = /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9][a-z0-9-]{0,62}$/; // publisher.name
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CMD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Paths inside the extension: relative, forward slashes, no `..`, no absolute/drive paths. */
export const RelPath = z.string().min(1).max(512).refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === ''), 'must be a relative path inside the extension (no "..", no absolute paths, use "/")');

const ACTIVATION = /^(\*|onStartupFinished|onCommand:[A-Za-z0-9._-]+|onLanguage:[A-Za-z0-9_-]+|onView:[A-Za-z0-9._-]+)$/;

export const Manifest = z.object({
  manifestVersion: z.literal(1),
  name: z.string().regex(NAME, 'lowercase letters, digits and "-"'),
  publisher: z.string().regex(NAME, 'lowercase letters, digits and "-"'),
  displayName: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  version: z.string().regex(SEMVER_RE, 'must be semver x.y.z'),
  license: z.string().max(100).optional(),
  engines: z.object({ nova: z.string().refine(validRange, 'invalid version range (use *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z)') }),
  main: RelPath.optional(),
  permissions: z.array(z.enum(PERMISSION_IDS as [string, ...string[]])).max(PERMISSION_IDS.length).default([]),
  activationEvents: z.array(z.string().regex(ACTIVATION, 'unsupported activation event')).max(200).default([]),
  contributes: z.object({
    commands: z.array(z.object({ command: z.string().regex(CMD), title: z.string().min(1).max(200), category: z.string().max(100).optional() })).max(500).default([]),
    menus: z.object({
      commandPalette: z.array(z.object({ command: z.string().regex(CMD), when: z.literal('never').optional() })).max(500).default([]),
      'editor/context': z.array(z.object({ command: z.string().regex(CMD), group: z.string().max(100).optional(), when: z.string().regex(/^editorLangId == [A-Za-z0-9_-]+$/).optional() })).max(200).default([]),
    }).default({ commandPalette: [], 'editor/context': [] }),
    configuration: z.object({
      title: z.string().max(100).optional(),
      properties: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), z.object({
        type: z.enum(['string', 'number', 'boolean']), default: z.union([z.string(), z.number(), z.boolean()]), description: z.string().max(500).default(''),
        enum: z.array(z.union([z.string(), z.number()])).max(100).optional(),
      })).default({}),
    }).default({ properties: {} }),
    themes: z.array(z.object({ id: z.string().regex(CMD), label: z.string().min(1).max(100), uiTheme: z.enum(['vs-dark', 'vs', 'hc-black']), path: RelPath })).max(50).default([]),
    languages: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), aliases: z.array(z.string().max(64)).max(10).default([]), extensions: z.array(z.string().regex(/^\.[A-Za-z0-9_.-]{1,32}$/)).max(50).default([]), configuration: RelPath.optional() })).max(50).default([]),
    grammars: z.array(z.object({ language: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), format: z.literal('monarch').default('monarch'), path: RelPath })).max(50).default([]),
    snippets: z.array(z.object({ language: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), path: RelPath })).max(50).default([]),
    outputChannels: z.array(z.string().min(1).max(64)).max(20).default([]),
    views: z.array(z.object({ id: z.string().regex(CMD), name: z.string().min(1).max(100) })).max(20).default([]),
    tasks: z.array(z.object({ id: z.string().regex(CMD), label: z.string().min(1).max(200), command: z.string().regex(CMD) })).max(100).default([]),
  }).default({ commands: [], menus: { commandPalette: [], 'editor/context': [] }, configuration: { properties: {} }, themes: [], languages: [], grammars: [], snippets: [], outputChannels: [], views: [], tasks: [] }),
}).strict();
export type Manifest = z.infer<typeof Manifest>;
export const extensionId = (m: Pick<Manifest, 'publisher' | 'name'>) => `${m.publisher}.${m.name}`;
export const isExtensionId = (s: string) => ID.test(s);

export type ValidationResult = { ok: true; manifest: Manifest; warnings: string[] } | { ok: false; errors: string[] };

/** Validates JSON + cross-references; `novaVersion` checks engines.nova compatibility. */
export function validateManifest(raw: unknown, novaVersion?: string): ValidationResult {
  const r = Manifest.safeParse(raw);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const m = r.data; const errors: string[] = []; const warnings: string[] = [];
  const c = m.contributes;
  const cmds = new Set(c.commands.map((x) => x.command));
  if (cmds.size !== c.commands.length) errors.push('contributes.commands: duplicate command ids');
  for (const [k, list] of [['menus.commandPalette', c.menus.commandPalette], ['menus.editor/context', c.menus['editor/context']], ['tasks', c.tasks]] as const)
    for (const it of list) if (!cmds.has(it.command)) errors.push(`contributes.${k}: command '${it.command}' is not declared in contributes.commands`);
  const langs = new Set(c.languages.map((l) => l.id));
  for (const g of c.grammars) if (!langs.has(g.language)) warnings.push(`grammar for '${g.language}' targets a language this extension does not declare (must be built in)`);
  const needsMain = c.commands.length > 0 || c.views.length > 0 || m.activationEvents.length > 0;
  if (needsMain && !m.main) errors.push('main: required when the extension contributes commands/views or declares activationEvents');
  if (m.main && !m.activationEvents.length) warnings.push('activationEvents is empty: the extension code will never run');
  for (const e of m.activationEvents) {
    if (e.startsWith('onCommand:') && !cmds.has(e.slice(10))) errors.push(`activationEvents: '${e}' refers to an undeclared command`);
    if (e.startsWith('onView:') && !c.views.some((v) => v.id === e.slice(7))) errors.push(`activationEvents: '${e}' refers to an undeclared view`);
  }
  if (novaVersion && !satisfies(novaVersion, m.engines.nova)) errors.push(`engines.nova: requires NOVA ${m.engines.nova}, this is ${novaVersion}`);
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m, warnings };
}
