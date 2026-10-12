import { build } from 'esbuild';
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'bin/nova-ext.cjs', banner: { js: '#!/usr/bin/env node' }, logLevel: 'info' });
