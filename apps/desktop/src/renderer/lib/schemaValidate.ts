/**
 * Minimal, CSP-safe JSON Schema (draft-07 subset) validator — no code generation (ajv needs `new Function`, which the
 * renderer CSP forbids). Supports: type, const, enum, required, properties, additionalProperties, items, minItems,
 * maxItems, minLength, pattern, minimum, maximum, oneOf, anyOf. Used for YAML files (Monaco validates JSON itself).
 */
export type Schema = boolean | { [k: string]: unknown };
export interface SchemaError { path: (string | number)[]; message: string; kind: 'missing' | 'value' | 'key' }

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (t: string, v: unknown) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); };

export function validateSchema(schema: Schema, value: unknown, path: (string | number)[] = []): SchemaError[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [{ path, message: 'Not allowed here', kind: 'value' }];
  const s = schema as Record<string, unknown>;
  const errs: SchemaError[] = [];
  const err = (message: string, p = path, kind: SchemaError['kind'] = 'value') => errs.push({ path: p, message, kind });
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeOk(t, value))) { err(`Expected ${types.join(' or ')}, got ${typeOf(value)}`); return errs; }
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) err(`Must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) err(`Must be one of: ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  for (const k of ['oneOf', 'anyOf'] as const) {
    const alts = s[k] as Schema[] | undefined; if (!alts) continue;
    const results = alts.map((a) => validateSchema(a, value, path));
    const ok = results.filter((r) => !r.length).length;
    if (k === 'anyOf' ? ok === 0 : ok !== 1) {
      // Report the closest alternative (fewest errors) for a useful message.
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      if (ok > 1) err('Matches more than one allowed form'); else errs.push(...best);
    }
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) err(`Must be at least ${s.minLength} characters`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) err(typeof s.description === 'string' ? `Invalid value. ${s.description}` : `Must match ${s.pattern}`);
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) err(`Must be ≥ ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) err(`Must be ≤ ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) err(`Needs at least ${s.minItems} item(s)`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) err(`At most ${s.maxItems} item(s)`);
    if (s.items && typeof s.items === 'object') value.forEach((v, i) => errs.push(...validateSchema(s.items as Schema, v, [...path, i])));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in o)) err(`Missing required property "${r}"`, path, 'missing');
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validateSchema(props[k]!, v, [...path, k]));
      else if (s.additionalProperties === false) err(`Unknown property "${k}"`, [...path, k], 'key');
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') errs.push(...validateSchema(s.additionalProperties as Schema, v, [...path, k]));
    }
  }
  return errs;
}

/** Glob for contributed fileMatch: no "/" → file name; otherwise suffix-match on the workspace-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)${re}$`);
}
export const fileMatches = (patterns: string[], rel: string) => patterns.some((p) => globToRegExp(p).test(rel.replace(/\\/g, '/')));
