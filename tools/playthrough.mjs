/**
 * Full-run visual check. Drives the game with the same lane-picking policy the
 * balance harness uses, so the screenshots show what a competent run actually
 * looks like -- including the crescendo and the boss, which a scripted drag
 * never survives to reach.
 *
 * Steering writes world.targetXRaw directly (the sim's own steering input), so
 * the springs, clamps and camera all behave exactly as they do under a thumb.
 */
import { chromium } from 'playwright-core'
import { findChrome, CHROME_ARGS, shotDir } from './chrome.mjs'

const SHOTS = shotDir()
const URL = process.env.GAME_URL || 'http://localhost:5180/'
const AIM = Number(process.env.AIM || 0.85)

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: CHROME_ARGS,
})
const VW = Number(process.env.VW || 430), VH = Number(process.env.VH || 900)
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: Number(process.env.DPR || 2) })
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' | ')))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(URL, { waitUntil: 'load', timeout: 20000 })
await page.waitForTimeout(1600)
await page.mouse.click(VW / 2, VH / 2)
await page.waitForTimeout(400)

// Install the autopilot inside the page.
await page.evaluate((aim) => {
  const g = window.__game
  const w = g.world
  const CFG = g.CFG
  let cooldown = 0
  let target = 0
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  function crowdAt(x) {
    let n = 0
    for (let i = 0; i < w.zombies.size; i++) {
      const z = w.zombies.items[i]
      if (z.dead || z.z < -16 || z.z > 0.5) continue
      if (Math.abs(z.x - x) < 1.3) n++
    }
    return n
  }
  function pick() {
    let best = null, bestScore = -Infinity
    for (let i = 0; i < w.props.size; i++) {
      const p = w.props.items[i]
      if (p.dead || p.z > -1) continue
      const timeLeft = (0 - p.z) / Math.max(1, w.scroll)
      if (timeLeft > 6.5) continue
      const ttk = p.hp / Math.max(1, w.nominalDPS)
      const gate = p.gatedBy && !p.gatedBy.dead ? p.gatedBy.hp / Math.max(1, w.nominalDPS) : 0
      const total = ttk + gate
      if (total > timeLeft * 1.15) continue
      let sc = p.kind === 'bubble'
        ? (p.reward && p.reward.type === 'weapon' ? 22 : 11) - total
        : p.role === 'wall' ? 16 - total : 3 - total
      sc -= Math.abs(p.x - w.anchorX) * 0.15
      sc -= crowdAt(p.x) * 1.1
      if (sc > bestScore) { bestScore = sc; best = p }
    }
    // Dodge boss shockwaves: stand in the gap.
    for (let i = 0; i < w.shockwaves.size; i++) {
      const s = w.shockwaves.items[i]
      if (s.dead || s.hit) continue
      if (s.z > -22 && s.z < 2) return clamp(s.gapX, -CFG.world.clampX, CFG.world.clampX)
    }
    if (!best) {
      let bx = w.anchorX, bn = Infinity
      for (let x = -CFG.world.clampX; x <= CFG.world.clampX; x += 0.75) {
        const n = crowdAt(x) + Math.abs(x - w.anchorX) * 0.08
        if (n < bn) { bn = n; bx = x }
      }
      return bx
    }
    return best.x
  }
  window.__autopilot = (dt) => {
    cooldown -= dt
    if (cooldown <= 0) { cooldown = 0.10 + (1 - aim) * 0.5; target = pick() }
    const speed = CFG.input.cruiseSpeed * (0.50 + 0.70 * aim)
    const d = target - w.targetXRaw
    w.targetXRaw = clamp(w.targetXRaw + clamp(d, -speed * dt, speed * dt),
      -CFG.world.clampX, CFG.world.clampX)
  }
  const tick = () => { window.__autopilot(1 / 60); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}, AIM)

const marks = [10, 25, 40, 55, 70, 85, 96, 100, 106, 112, 118, 126, 134, 145]
const done = new Set()
const t0 = Date.now()
let last = null
while ((Date.now() - t0) / 1000 < 190) {
  const st = await page.evaluate(() => {
    const w = window.__game.world
    return { t: w.runTime, state: w.state, count: w.count, tier: w.tier, z: w.zombies.size,
             boss: w.boss.active ? Math.round(100 * w.boss.hp / w.boss.maxHp) : -1 }
  })
  last = st
  const sec = Math.floor(st.t)
  for (const m of marks) {
    if (sec >= m && !done.has(m)) {
      done.add(m)
      await page.screenshot({ path: `${SHOTS}/run-t${String(m).padStart(3, '0')}.png` })
      console.log(`t=${m}s state=${st.state} squad=${st.count} tier=${st.tier} zombies=${st.z}` +
        (st.boss >= 0 ? ` boss=${st.boss}%` : ''))
    }
  }
  if (st.state === 3 || st.state === 4) break
  await page.waitForTimeout(180)
}
await page.waitForTimeout(600)
await page.screenshot({ path: `${SHOTS}/run-end.png` })
console.log('FINAL:', JSON.stringify(last))
console.log('ERRORS(' + errors.length + '):', errors.slice(0, 8).join('\n  '))
await browser.close()
