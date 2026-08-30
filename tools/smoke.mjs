/**
 * Browser smoke test: boots the real game in headless Chrome, plays it for a few
 * seconds of simulated input, and reports console errors + screenshots.
 * Run: node tools/smoke.mjs [seconds]
 */
import { chromium } from 'playwright-core'
import { findChrome } from './chrome.mjs'

const SHOTS = process.env.SHOT_DIR || '/tmp/shots'
const URL = process.env.GAME_URL || 'http://localhost:5180/'
const SECONDS = Number(process.argv[2] || 12)

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 })

const errors = []
const logs = []
page.on('console', (m) => {
  const t = m.type()
  const txt = m.text()
  if (t === 'error') errors.push(txt)
  else logs.push(t + ': ' + txt)
})
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))))

await page.goto(URL, { waitUntil: 'load', timeout: 20000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: SHOTS + '/01-start.png' })

// Tap to start (the overlay's tap-anywhere scrim).
await page.mouse.click(215, 450)
await page.waitForTimeout(900)
await page.screenshot({ path: SHOTS + '/02-early.png' })

// Play: drag left and right across lanes for the requested duration.
const t0 = Date.now()
let x = 215
await page.mouse.move(x, 700)
await page.mouse.down()
let shotAt = new Set()
while ((Date.now() - t0) / 1000 < SECONDS) {
  const t = (Date.now() - t0) / 1000
  x = 215 + Math.sin(t * 0.55) * 95
  await page.mouse.move(x, 700)
  await page.waitForTimeout(24)
  const sec = Math.floor(t)
  for (const mark of [7, 12, 18, 24, 30, 40, 55, 70]) {
    if (sec === mark && !shotAt.has(mark)) {
      shotAt.add(mark)
      await page.screenshot({ path: SHOTS + `/t${String(mark).padStart(2, '0')}.png` })
    }
  }
}
await page.mouse.up()

const state = await page.evaluate(() => {
  const g = window.__game
  if (!g) return { error: 'window.__game missing' }
  const w = g.world
  return {
    state: w.state, runTime: +w.runTime.toFixed(1), count: w.count, tier: w.tier,
    dps: Math.round(w.nominalDPS), anchorX: +w.anchorX.toFixed(2),
    zombies: w.zombies.size, props: w.props.size, soldiers: w.soldiers.size,
    joiners: w.joiners.size, kills: w.stats.kills,
    bubblesTaken: w.stats.bubblesTaken, barrelsKilled: w.stats.barrelsKilled,
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    programs: g.renderer.info.programs ? g.renderer.info.programs.length : -1,
    geometries: g.renderer.info.memory.geometries,
    textures: g.renderer.info.memory.textures,
  }
})

await page.screenshot({ path: SHOTS + '/03-final.png' })
console.log('STATE:', JSON.stringify(state, null, 1))
console.log('\nERRORS (' + errors.length + '):')
for (const e of errors.slice(0, 25)) console.log('  ' + e.slice(0, 400))
if (logs.length) { console.log('\nLOGS (' + logs.length + '):'); for (const l of logs.slice(0, 10)) console.log('  ' + l.slice(0, 200)) }
await browser.close()
process.exit(errors.length ? 1 : 0)
