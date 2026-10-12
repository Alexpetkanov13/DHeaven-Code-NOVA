import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, chunkSizeWarningLimit: 6000, target: 'chrome128' },
  worker: { format: 'es' },
  server: { strictPort: true },
});
