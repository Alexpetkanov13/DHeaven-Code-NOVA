/**
 * Permissions an extension may request. Nothing outside this list is grantable.
 * Declared in the manifest; each is granted or denied by the user on first use (prompt), and can be revoked later.
 */
export const PERMISSIONS = {
  'workspace.read': 'Read files in the open workspace',
  'workspace.write': 'Create and modify files in the open workspace',
  network: 'Make network requests (HTTP/HTTPS)',
  process: 'Run programs on this computer',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as Permission[];
export type GrantState = 'granted' | 'denied';

/** Which permission each host→main API call needs (null = always allowed: UI-only, scoped to the extension). */
export const API_PERMISSIONS: Record<string, Permission | null> = {
  'window.showMessage': null,
  'window.setStatus': null,
  'output.append': null,
  'output.clear': null,
  'output.show': null,
  'commands.execute': null,
  'tree.refresh': null,
  'state.update': null,
  'workspace.readFile': 'workspace.read',
  'workspace.listDir': 'workspace.read',
  'workspace.writeFile': 'workspace.write',
  'net.fetch': 'network',
  'process.exec': 'process',
};

export type Decision = { allow: true } | { allow: false; reason: string } | { ask: Permission };
/** Pure capability check used by main before serving any extension RPC. */
export function checkCapability(method: string, declared: readonly string[], grants: Partial<Record<string, GrantState>>): Decision {
  if (!(method in API_PERMISSIONS)) return { allow: false, reason: `Unknown API ${method}` };
  const need = API_PERMISSIONS[method]!;
  if (need === null) return { allow: true };
  if (!declared.includes(need)) return { allow: false, reason: `Permission '${need}' is not declared in the extension manifest` };
  const g = grants[need];
  if (g === 'granted') return { allow: true };
  if (g === 'denied') return { allow: false, reason: `Permission '${need}' was denied by the user` };
  return { ask: need };
}
