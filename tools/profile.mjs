/** Per-module frame cost. Finds which view module owns the spikes. */
import { chromium } from 'playwright-core'
import { findChrome, CHROME_ARGS, shotDir } from './chrome.mjs'
const b = await chromium.launch({
  executablePath: findChrome(),
  headless: true, args: CHROME_ARGS,
})
const p = await b.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 })
await p.goto(process.env.GAME_URL || 'http://localhost:5180/', { waitUntil: 'load' })
await p.waitForTimeout(1500)
await p.mouse.click(215, 450)
await p.waitForTimeout(600)
await p.evaluate(() => { window.__game.world.runTime = 60 })
await p.waitForTimeout(2500)
const r = await p.evaluate(() => new Promise((resolve) => {
  const g = window.__game
  const acc = {}
  for (const [name, mod] of Object.entries(g.views)) {
    if (!mod || typeof mod.sync !== 'function') continue
    acc[name] = []
    const orig = mod.sync.bind(mod)
    mod.sync = (...a) => { const t = performance.now(); const v = orig(...a); acc[name].push(performance.now() - t); return v }
  }
  const rt = []
  const origRender = g.renderer.render.bind(g.renderer)
  g.renderer.render = (s, c) => { const t = performance.now(); origRender(s, c); rt.push(performance.now() - t) }
  let n = 0
  function tick() {
    if (++n < 320) requestAnimationFrame(tick)
    else {
      const stat = (arr) => {
        if (!arr || !arr.length) return null
        const s = arr.slice(20).sort((x, y) => x - y)
        return { p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }
      }
      const out = { gpuSubmit: stat(rt) }
      for (const k of Object.keys(acc)) out[k] = stat(acc[k])
      resolve(out)
    }
  }
  requestAnimationFrame(tick)
}))
for (const [k, v] of Object.entries(r)) {
  if (v) console.log(k.padEnd(14), 'p50', String(v.p50).padStart(7), ' p95', String(v.p95).padStart(7), ' max', String(v.max).padStart(8))
}
await b.close()
