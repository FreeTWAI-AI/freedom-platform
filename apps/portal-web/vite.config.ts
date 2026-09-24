import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const appRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: appRoot,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {index:join(appRoot,'index.html'),'skill-social':join(appRoot,'src/skill-social.tsx')},
      output: {entryFileNames: chunk=>chunk.name==='skill-social'?'assets/skill-social.js':'assets/[name]-[hash].js'},
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true },
      '/public': { target: 'http://127.0.0.1:4310', changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
  },
})
