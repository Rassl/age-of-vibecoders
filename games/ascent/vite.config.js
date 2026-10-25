import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Ascent lives in the hub repo under games/ascent and deploys at /ascent/
// next to the runner. Asset URLs in src/ are relative ('assets/...'), so
// they resolve against the page's own folder; `base` covers the HTML and
// the CSS. The build lands straight in the hub's dist/ascent.
//
// HTTPS on the LAN: WebXR needs a secure context, and the headset reaches the
// dev server by the Mac's local address.
export default defineConfig({
  base: '/ascent/',
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { chunkSizeWarningLimit: 1200, outDir: '../../dist/ascent', emptyOutDir: true },
});
