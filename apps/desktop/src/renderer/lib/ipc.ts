import type { ChannelName, NovaApi, Req, Res } from '@nova/ipc-contract';

declare global { interface Window { nova: NovaApi } }

export class IpcError extends Error { constructor(public code: string, message: string) { super(message); } }

export async function call<C extends ChannelName>(channel: C, req: Req<C>): Promise<Res<C>> {
  const env = await window.nova.invoke(channel, req);
  if (!env.ok) throw new IpcError(env.error.code, env.error.message);
  return env.result;
}
