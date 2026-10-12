import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron'], sourcemap: true, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' });
// Sandboxed preload: single CJS file, only `electron` may be required.
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/main/preload.cjs' });
