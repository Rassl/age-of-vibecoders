// Screenshots the preview mode with headless Chrome.
//   node tools/shot.mjs OUT.png "query string" [waitSeconds]
import { chromium } from 'playwright-core';
const [out, query = '', wait = '12'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const logs = [];
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('no image data')) logs.push(`${m.type()}: ${m.text()}`); });
page.on('requestfailed', (r) => logs.push('failed: ' + r.url().slice(0, 120) + ' ' + r.failure()?.errorText));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(`https://localhost:5173/?${query}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(parseFloat(wait) * 1000);
if (process.env.PRE) { await page.evaluate(process.env.PRE); await page.waitForTimeout(parseFloat(process.env.PREWAIT || '0.5') * 1000); }
await page.screenshot({ path: out });
if (process.env.EVAL) console.log('eval:', JSON.stringify(await page.evaluate(process.env.EVAL)));
console.log(logs.slice(0, 20).join('\n') || 'no errors');
await browser.close();
