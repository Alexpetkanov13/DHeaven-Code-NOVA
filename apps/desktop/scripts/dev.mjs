// Dev loop: Vite dev server for the renderer + bundled main/preload, then launch Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen(5173);
await import('./build-main.mjs');
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, NOVA_DEV_URL: 'http://localhost:5173/index.html' } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
