import { contextBridge, ipcRenderer } from 'electron';
import type { NovaApi } from '@nova/ipc-contract';

// Only this narrow, frozen API is exposed. The renderer never gets ipcRenderer, fs, or process.
const api: NovaApi = {
  invoke: (channel, req) => ipcRenderer.invoke('nova:invoke', channel, req),
  onMenu: (cb) => {
    const l = (_e: unknown, cmd: unknown) => { if (typeof cmd === 'string') cb(cmd); };
    ipcRenderer.on('nova:menu', l);
    return () => { ipcRenderer.removeListener('nova:menu', l); };
  },
  onEvent: (name, cb) => {
    const l = (_e: unknown, n: unknown, payload: unknown) => { if (n === name) cb(payload as never); };
    ipcRenderer.on('nova:event', l);
    return () => { ipcRenderer.removeListener('nova:event', l); };
  },
};
contextBridge.exposeInMainWorld('nova', Object.freeze(api));
