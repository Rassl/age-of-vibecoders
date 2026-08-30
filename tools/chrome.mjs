/**
 * Locate a Chrome/Chromium binary for the browser-driving tools.
 *
 * These scripts use playwright-core, which deliberately ships NO browser -- it
 * drives one you already have. That keeps the repo's install small, but it means
 * the binary path is environment-specific, and hardcoding the macOS app bundle
 * (as every tool here originally did) makes all of them fail immediately for any
 * Linux or Windows contributor.
 *
 * Resolution order:
 *   1. $CHROME_PATH  -- explicit override, always wins
 *   2. the usual install locations for this platform
 *   3. a clear error naming the override, rather than a playwright stack trace
 */
import { existsSync } from 'node:fs'
import { platform } from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}

export function findChrome() {
  const override = process.env.CHROME_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CHROME_PATH is set but does not exist: ${override}`)
    }
    return override
  }
  for (const p of CANDIDATES[platform] || []) {
    if (existsSync(p)) return p
  }
  throw new Error(
    `No Chrome/Chromium found for platform "${platform}".\n` +
    'These tools drive a browser you already have (playwright-core ships none).\n' +
    'Install Chrome, or point CHROME_PATH at a binary:\n' +
    '  CHROME_PATH=/path/to/chrome node tools/smoke.mjs\n' +
    'Note: tools/harness.mjs needs no browser and runs anywhere.'
  )
}

/**
 * Launch args shared by every browser tool here.
 *
 * `--use-angle=metal` selects a macOS-only ANGLE backend; passing it on Linux or
 * Windows is at best ignored and at worst refuses to start, so it is gated.
 */
export const CHROME_ARGS = [
  '--hide-scrollbars',
  '--enable-unsafe-swiftshader',
  ...(platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal'] : ['--use-gl=angle']),
]

/** Default screenshot directory. `/tmp` does not exist on Windows. */
export function shotDir() {
  return process.env.SHOT_DIR || join(tmpdir(), 'aov-shots')
}
