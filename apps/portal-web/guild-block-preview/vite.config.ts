import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)), publicDir: false,
  resolve: {dedupe: ['react', 'react-dom']},
  server: {host: '127.0.0.1', port: 4337},
  preview: {host: '127.0.0.1', port: 4337},
  build: {outDir: 'dist', emptyOutDir: true},
});
