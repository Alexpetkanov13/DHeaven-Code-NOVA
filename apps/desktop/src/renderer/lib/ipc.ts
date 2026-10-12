import type { ChannelName, NovaApi, Req, Res } from '@nova/ipc-contract';

declare global { interface Window { nova: NovaApi } }

export class IpcError extends Error { constructor(public code: string, message: string) { super(message); } }

export async function call<C extends ChannelName>(channel: C, req: Req<C>): Promise<Res<C>> {
  const env = await window.nova.invoke(channel, req);
  if (!env.ok) throw new IpcError(env.error.code, env.error.message);
  return env.result;
}

import type { EventName, Events } from '@nova/ipc-contract';
export function on<E extends EventName>(name: E, cb: (p: Events[E]) => void) { return window.nova.onEvent(name, cb); }

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
