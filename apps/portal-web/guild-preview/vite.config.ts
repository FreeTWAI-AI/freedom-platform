import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  resolve: {dedupe: ['react', 'react-dom']},
  server: {host: '127.0.0.1', port: 4487, strictPort: true, watch: {usePolling: process.env.GUILD_PREVIEW_POLL === '1', interval: 500}},
  preview: {host: '127.0.0.1', port: 4487, strictPort: true},
  build: {outDir: 'dist', emptyOutDir: true},
});
