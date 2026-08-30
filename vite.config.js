import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { open: true, host: true },
  build: { target: 'es2022', outDir: 'dist' },
})
