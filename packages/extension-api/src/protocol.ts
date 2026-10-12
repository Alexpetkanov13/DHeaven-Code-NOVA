/** Wire protocol between NOVA main and the extension host process (JSON over the Node IPC channel). */
import type { Manifest } from './manifest';

export interface HostExtension { id: string; path: string; manifest: Manifest; config: Record<string, unknown>; state: Record<string, unknown> }
export type MainToHost =
  | { t: 'req'; id: number; method: 'activate'; params: { ext: HostExtension; event: string } }
  | { t: 'req'; id: number; method: 'deactivate'; params: { extId: string } }
  | { t: 'req'; id: number; method: 'executeCommand'; params: { command: string; args: unknown[] } }
  | { t: 'req'; id: number; method: 'getChildren'; params: { viewId: string; element: unknown } }
  | { t: 'req'; id: number; method: 'ping'; params: Record<string, never> }
  | { t: 'req'; id: number; method: 'configChanged'; params: { extId: string; config: Record<string, unknown> } }
  | { t: 'res'; id: number; result?: unknown; error?: string };
export type HostToMain =
  | { t: 'req'; id: number; extId: string; method: string; params: unknown }
  | { t: 'res'; id: number; result?: unknown; error?: string }
  | { t: 'log'; extId: string | null; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'registered'; extId: string; kind: 'command' | 'view'; key: string }
  | { t: 'ready' };
