/**
 * Frame-timing probe. Reports the rAF cadence, the render cost, and how evenly
 * the fixed-timestep substeps land -- the three things that separate "slow" from
 * "juddery", which need completely different fixes.
 */
import { chromium } from 'playwright-core'
import { findChrome } from './chrome.mjs'
const b = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--hide-scrollbars'],
})
const p = await b.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 })
await p.goto('http://localhost:5180/', { waitUntil: 'load' })
await p.waitForTimeout(1500)
await p.mouse.click(215, 450)
await p.waitForTimeout(600)
await p.evaluate(() => { window.__game.world.runTime = 55 })

const r = await p.evaluate(() => new Promise((resolve) => {
  const g = window.__game
  const frames = []
  const steps = []
  let last = performance.now()
  const origStep = g.loop.step
  let stepCount = 0
  g.loop.step = (dt, n) => { stepCount++; return origStep(dt, n) }
  function tick() {
    const now = performance.now()
    frames.push(now - last)
    steps.push(stepCount)
    stepCount = 0
    last = now
    if (frames.length < 300) requestAnimationFrame(tick)
    else {
      const sorted = frames.slice(20).sort((a, b) => a - b)
      const pct = (q) => sorted[Math.floor(sorted.length * q)]
      const hist = {}
      for (const s of steps.slice(20)) hist[s] = (hist[s] || 0) + 1
      resolve({
        frames: sorted.length,
        fps: +(1000 / (sorted.reduce((a, b) => a + b, 0) / sorted.length)).toFixed(1),
        p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2),
        substepsPerFrame: hist,
        drawCalls: g.renderer.info.render.calls,
      })
    }
  }
  requestAnimationFrame(tick)
}))
console.log(JSON.stringify(r, null, 1))
await b.close()
