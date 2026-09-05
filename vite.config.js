import { defineConfig } from 'vite'
import { existsSync, readFileSync } from 'node:fs'

// HTTPS=1 npm run dev (or `npm run dev:https`) serves over TLS with the mkcert
// certificate in certs/ (git-ignored). WebXR is a secure-context API, so a
// headset on the same wifi needs this; plain http only gets it on localhost.
//   mkcert -key-file certs/dev-key.pem -cert-file certs/dev-cert.pem localhost 127.0.0.1 <lan-ip>
const CERT = 'certs/dev-cert.pem'
const KEY = 'certs/dev-key.pem'
const https = process.env.HTTPS && existsSync(CERT) && existsSync(KEY)
  ? { cert: readFileSync(CERT), key: readFileSync(KEY) }
  : undefined

export default defineConfig({
  base: './',
  // PORT IS PINNED, and strictPort so a collision fails loudly.
  // Every tool in tools/ targets localhost:5180. Vite's default is 5173, so
  // without this the browser tools silently point at nothing -- they were broken
  // for everyone, including on the author's machine. Sliding to 5181 on a
  // collision would be worse: the tools would quietly drive a STALE server.
  server: { open: true, host: true, port: 5180, strictPort: true, https },
  build: { target: 'es2022', outDir: 'dist' },
})
