import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // PORT IS PINNED, and strictPort so a collision fails loudly.
  // Every tool in tools/ targets localhost:5180. Vite's default is 5173, so
  // without this the browser tools silently point at nothing -- they were broken
  // for everyone, including on the author's machine. Sliding to 5181 on a
  // collision would be worse: the tools would quietly drive a STALE server.
  server: { open: true, host: true, port: 5180, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
})
