/** Minimal semver: `x.y.z[-pre]` versions; ranges `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, and space-separated AND of those. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
type V = [number, number, number, string | null];
export function parse(v: string): V | null {
  const m = SEMVER_RE.exec(v.trim()); if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}
export function compare(a: string, b: string): number {
  const x = parse(a), y = parse(b); if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1; if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}
const RANGE_PART = /^(\^|~|>=|>|<=|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
export function validRange(r: string): boolean { return r.trim() === '*' || r.trim().split(/\s+/).every((p) => RANGE_PART.test(p)); }
export function satisfies(version: string, range: string): boolean {
  if (!parse(version)) return false;
  if (range.trim() === '*') return true;
  return range.trim().split(/\s+/).every((part) => {
    const m = RANGE_PART.exec(part); if (!m) return false;
    const op = m[1] ?? '=', base = m[2]!, b = parse(base)!, c = compare(version, base);
    switch (op) {
      case '=': return c === 0;
      case '>=': return c >= 0; case '>': return c > 0; case '<=': return c <= 0; case '<': return c < 0;
      case '~': return c >= 0 && compare(version, `${b[0]}.${b[1] + 1}.0-0`) < 0;
      case '^': {
        const upper = b[0] > 0 ? `${b[0] + 1}.0.0-0` : b[1] > 0 ? `0.${b[1] + 1}.0-0` : `0.0.${b[2] + 1}-0`;
        return c >= 0 && compare(version, upper) < 0;
      }
      default: return false;
    }
  });
}
