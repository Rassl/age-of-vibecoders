/**
 * Smoothness probe: how evenly does the DRAWN world advance?
 *
 * Perfect smoothness means the distance drawn each frame advances in proportion
 * to that frame's duration. Judder shows up as advance-per-millisecond varying
 * wildly frame to frame -- including frames that advance by zero.
 */
import { chromium } from 'playwright-core'
import { findChrome } from './chrome.mjs'
const b = await chromium.launch({
  executablePath: findChrome(),
  headless: true, args: ['--hide-scrollbars', '--use-angle=metal'],
})
const p = await b.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 })
await p.goto('http://localhost:5180/', { waitUntil: 'load' })
await p.waitForTimeout(1500)
await p.mouse.click(215, 450)
await p.waitForTimeout(1200)
const r = await p.evaluate(() => new Promise((resolve) => {
  const speeds = []
  let lastD = window.__drawDistance
  let lastT = performance.now()
  let n = 0, zeroFrames = 0
  function tick() {
    const d = window.__drawDistance
    const t = performance.now()
    const dt = t - lastT
    if (d !== undefined && lastD !== undefined && dt > 1 && n > 10) {
      const v = (d - lastD) / dt          // world units per ms actually drawn
      speeds.push(v)
      if (Math.abs(d - lastD) < 1e-6) zeroFrames++
    }
    lastD = d; lastT = t
    if (++n < 400) requestAnimationFrame(tick)
    else {
      const clean = speeds.filter(Number.isFinite)
      const mean = clean.reduce((a, c) => a + c, 0) / clean.length
      const varr = clean.reduce((a, c) => a + (c - mean) ** 2, 0) / clean.length
      const cv = Math.sqrt(varr) / mean   // coefficient of variation: 0 = perfect
      resolve({
        frames: speeds.length,
        finite: clean.length,
        sample: clean.slice(0, 6).map(v => +(v * 1000).toFixed(2)),
        meanUnitsPerSec: +(mean * 1000).toFixed(2),
        jitterCV: +cv.toFixed(3),
        framesThatDrewNoMovement: zeroFrames,
      })
    }
  }
  requestAnimationFrame(tick)
}))
console.log(JSON.stringify(r, null, 1))
await b.close()
