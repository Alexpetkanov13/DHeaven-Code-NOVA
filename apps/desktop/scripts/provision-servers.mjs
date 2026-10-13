// CI/dev helper: installs the pinned language servers + java-debug (same URLs + SHA-256 as the app) into a folder.
// Usage: node scripts/provision-servers.mjs <dir>   (skips servers already installed)
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'nova-servers'));
const entry = path.join(os.tmpdir(), `nova-provision-${process.pid}.mjs`);
await build({
  stdin: { contents: "export { installServer } from './src/main/lsp/installer'; export { SERVERS } from './src/main/lsp/registry'; export { JAVA_DEBUG } from './src/main/dap/java';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: entry, logLevel: 'error',
});
const { installServer, SERVERS, JAVA_DEBUG } = await import(pathToFileURL(entry).href);
fs.mkdirSync(dir, { recursive: true });
for (const def of [...Object.values(SERVERS), JAVA_DEBUG]) {
  const dest = def.installDir(dir);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) { console.log(`ok (cached) ${def.id} ${def.version}`); continue; }
  await installServer(def, dir, fetch, (m) => console.log(`[${def.id}] ${m}`));
}
fs.rmSync(entry, { force: true });
console.log(`servers ready in ${dir}`);
