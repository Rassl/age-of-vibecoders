/**
 * Captures a hero gameplay plate for the link-preview card: a grown squad on
 * wings under fire, HUD hidden. Needs the dev server (GAME_URL, default
 * http://localhost:5180/). Output: tools/og-plate.png (git-ignored).
 */
import { chromium } from 'playwright-core'
import { findChrome, CHROME_ARGS } from './chrome.mjs'
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: CHROME_ARGS, ignoreHTTPSErrors: true })
// 0.72 is the stage's widest aspect; the stage then fills this viewport exactly.
const page = await browser.newPage({ viewport: { width: 900, height: 1250 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true })
await page.goto('process.env.GAME_URL || 'http://localhost:5180/'', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(3500)
await page.mouse.click(450, 600)
await page.waitForTimeout(1200)
// Stage a hero moment: a bigger squad on wings, a can bubble and a barrel ahead, a crowd under them.
await page.evaluate(() => {
  const g = window.__game, w = g.world
  w.pendingAdds = 14
  w.runTime = 30.5; w.beatCursor = 5; w.gateCursor = 2
})
await page.waitForTimeout(2600)
await page.evaluate(() => {
  const g = window.__game, w = g.world
  w.wings = 10
  g.bus.emit(g.T.WINGS_ON, w.anchorX, 1.2, 0, 10)
})
await page.waitForTimeout(2200)
// Hide the DOM HUD and the dev switcher for a clean plate.
await page.evaluate(() => { for (const el of document.querySelectorAll('#hud, #stage > div:not(#vignette)')) if (el.id !== 'stage') el.style.visibility = 'hidden' })
await page.waitForTimeout(100)
await page.screenshot({ path: new URL('./og-plate.png', import.meta.url).pathname })
console.log('plate captured')
await browser.close()
