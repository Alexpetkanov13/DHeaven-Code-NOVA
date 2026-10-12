export const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name).replace(/\\/g, '/');
export const joinAbs = (root: string, rel: string) => (rel ? `${root.replace(/[\\/]+$/, '')}/${rel}` : root);
/** Workspace-relative path for an absolute fs path, or null if outside the root (case-insensitive on Windows-style drives). */
export function uriToRel(fsPath: string, root: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(fsPath), r = norm(root);
  const win = /^[a-zA-Z]:/.test(r);
  const eq = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(a, r)) return '';
  if (!eq(a.slice(0, r.length + 1), r + '/')) return null;
  const rel = a.slice(r.length + 1);
  return rel.split('/').includes('..') ? null : rel;
}
