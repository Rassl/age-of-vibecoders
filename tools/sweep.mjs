/** Parameter sweep: run the real sim across a grid and report the skill gradient. */
import { CFG, deriveConfig, FIXED_DT } from '../src/config.js'
import { MAX_TIER } from '../src/data/weapons.js'
import { createWorld, STATE } from '../src/sim/world.js'
import { startRun } from '../src/sim/run.js'
import { runStep } from '../src/sim/systems.js'
import { bus } from '../src/core/bus.js'
import { Rng } from '../src/util/rng.js'
import { makeBot, pickLane } from './bot.mjs'

deriveConfig(430, 900)



function simulate(aim, seed) {
  const w = createWorld(seed)
  startRun(w, seed)
  const bot = makeBot(aim, seed ^ 0x5f3759df)
  let t = 0
  while (t < 300 && w.state !== STATE.WON && w.state !== STATE.LOST) {
    runStep(w, FIXED_DT, bot.decide(w, FIXED_DT))
    bus.drain()
    bus.clear()
    t += FIXED_DT
  }
  return { win: w.state === STATE.WON, peak: w.stats.peakCount, t, tier: w.tier }
}

const LEVELS = [['EXP', 0.95], ['GOOD', 0.86], ['COMP', 0.78], ['SHKY', 0.69], ['CLMS', 0.58], ['BAD', 0.40]]
const SEEDS = 9

function evaluate(label) {
  const row = []
  for (const [, aim] of LEVELS) {
    let wins = 0, peak = 0, tSum = 0
    for (let s = 0; s < SEEDS; s++) {
      const r = simulate(aim, 1000 + s * 7919)
      if (r.win) wins++
      peak += r.peak
      tSum += r.t
    }
    row.push({ wins, peak: Math.round(peak / SEEDS), t: Math.round(tSum / SEEDS) })
  }
  const monotone = row.every((r, i) => i === 0 || row[i - 1].wins >= r.wins)
  console.log(label.padEnd(26),
    row.map((r, i) => LEVELS[i][0] + ':' + r.wins + '/' + SEEDS).join(' '),
    ' peak', row.map(r => String(r.peak).padStart(2)).join('/'),
    monotone ? ' MONOTONE' : '')
  return { row, monotone }
}

const grid = JSON.parse(process.argv[2] || '[]')
if (!grid.length) {
  evaluate('baseline')
} else {
  for (const cell of grid) {
    for (const [path, val] of Object.entries(cell)) {
      const parts = path.split('.')
      let o = CFG
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]
      o[parts[parts.length - 1]] = val
    }
    evaluate(Object.entries(cell).map(([k, v]) => k.split('.').pop() + '=' + v).join(' '))
  }
}
