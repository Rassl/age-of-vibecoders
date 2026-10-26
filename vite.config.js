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

// The site is a HUB: site/index.html is the landing page at `/`, and this game
// lives under /runner/ so more games can sit beside it. In dev the hub is
// served by the middleware below; in the build `npm run build` copies site/
// into dist/ next to dist/runner/.
const SITE_DIR = 'site'
const hubPlugin = {
  name: 'aov-hub',
  configureServer(server) {
    // Serve the hub's own files (page, hero image) the way the static deploy
    // does: anything under site/ answers at the root, the game owns /runner/.
    const TYPES = { html: 'text/html; charset=utf-8', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', css: 'text/css', js: 'text/javascript', txt: 'text/plain; charset=utf-8', xml: 'application/xml' }
    server.middlewares.use((req, res, next) => {
      const path = req.url.split('?')[0]
      const file = (path.endsWith('/') ? path + 'index.html' : path).slice(1)
      if (file.includes('..') || !existsSync(`${SITE_DIR}/${file}`)) return next()
      res.setHeader('Content-Type', TYPES[file.split('.').pop()] || 'application/octet-stream')
      res.end(readFileSync(`${SITE_DIR}/${file}`))
    })
  },
}

export default defineConfig({
  // Everything the game references is relative to its own page, so it works
  // wherever this base points; the hub links to it absolutely.
  base: '/runner/',
  plugins: [hubPlugin],
  // PORT IS PINNED, and strictPort so a collision fails loudly.
  // Every tool in tools/ targets localhost:5180. Vite's default is 5173, so
  // without this the browser tools silently point at nothing -- they were broken
  // for everyone, including on the author's machine. Sliding to 5181 on a
  // collision would be worse: the tools would quietly drive a STALE server.
  server: { open: true, host: true, port: 5180, strictPort: true, https },
  build: { target: 'es2022', outDir: 'dist/runner' },
})
