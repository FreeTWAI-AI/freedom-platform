import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const appRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: appRoot,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
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
