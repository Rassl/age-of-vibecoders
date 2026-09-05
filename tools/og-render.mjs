/**
 * Link-preview card: composes public/og.png (1200x630) from tools/og-plate.png
 * (captured by tools/og-plate.mjs, git-ignored) and tools/og-card.html.
 *   node tools/og-plate.mjs && node tools/og-render.mjs
 */
import { chromium } from 'playwright-core'
import { findChrome, CHROME_ARGS } from './chrome.mjs'
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: CHROME_ARGS })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.goto(new URL('./og-card.html', import.meta.url).href, { waitUntil: 'load' })
await page.waitForTimeout(400)
await page.screenshot({ path: new URL('../public/og.png', import.meta.url).pathname, type: 'png' })
console.log('rendered public/og.png')
await browser.close()
