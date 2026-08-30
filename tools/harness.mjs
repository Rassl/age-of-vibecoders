/**
 * Headless balance harness.
 *
 * Two jobs:
 *   1. FIREWALL: assert that nothing under src/sim/ imports three.js. Run as a
 *      prebuild step, this is what keeps "sim bug or render bug" answerable.
 *   2. BALANCE: play the real curves.js with bot policies of varying AIM
 *      EFFICIENCY -- the term that matters most, because bullets go straight and
 *      you aim with your body, so a player who cannot hold a lane delivers only
 *      a fraction of nominal DPS.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// Resolve against THIS FILE, not cwd. The firewall check is the one command the
// README tells contributors to run, and walking a cwd-relative 'src/sim' meant it
// died with a bare ENOENT stack trace anywhere but the repo root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIM_DIR = join(ROOT, 'src', 'sim')
import { CFG, deriveConfig, validateConfig, FIXED_DT } from '../src/config.js'
import { createWorld, STATE } from '../src/sim/world.js'
import { startRun } from '../src/sim/run.js'
import { runStep } from '../src/sim/systems.js'
import { bus } from '../src/core/bus.js'
import { Rng } from '../src/util/rng.js'
import { makeBot, pickLane } from './bot.mjs'
import { MAX_TIER } from '../src/data/weapons.js'
import { parDPS } from '../src/curves.js'

// ---------------------------------------------------------------- 1. firewall

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

function assertFirewall() {
  const offenders = []
  for (const f of walk(SIM_DIR)) {
    const src = readFileSync(f, 'utf8')
    if (/from\s+['"]three['"]|require\(['"]three['"]\)/.test(src)) offenders.push(f)
  }
  if (offenders.length) {
    console.error('FIREWALL VIOLATION -- src/sim must never import three.js:')
    for (const o of offenders) console.error('  ' + o)
    process.exit(1)
  }

  // The bus is one-directional: sim EMITS facts, presentation listens. A
  // subscriber registered from sim/ would make sim -> sim causality implicit and
  // frame-delayed, since the bus only drains once per frame in the view layer.
  const subscribers = []
  for (const f of walk(SIM_DIR)) {
    if (/\bbus\.on\s*\(/.test(readFileSync(f, 'utf8'))) subscribers.push(f)
  }
  if (subscribers.length) {
    console.error('BUS VIOLATION -- src/sim must never subscribe to the bus:')
    for (const o of subscribers) console.error('  ' + o)
    process.exit(1)
  }

  console.log('firewall: OK -- src/sim imports no three.js and subscribes to no bus topic ('
    + walk(SIM_DIR).length + ' files)')
}

// ----------------------------------------------------------------- 2. balance

/**
 * A bot with a given aim efficiency. It re-decides a lane every `reaction`
 * seconds and tracks it at a fraction of the lateral clamp, so low efficiency
 * means both late decisions and sloppy tracking -- exactly how a real player
 * loses DPS.
 */

/** Value the lanes: prefer a reachable bubble, then the cheapest live barrel. */

/** How many zombies are about to reach the squad plane near x. */


function simulate(aim, seed, trace = false) {
  const w = createWorld(seed)
  startRun(w, seed)
  const causes = { zombie: 0, breach: 0, shock: 0, boss: 0 }
  const CAUSE_NAME = { 1: 'zombie', 2: 'breach', 3: 'shock', 4: 'boss' }
  bus.on(10, (e) => { const n = CAUSE_NAME[e.a]; if (n) causes[n]++ })
  let weaponUps = 0
  bus.on(13, () => weaponUps++)
  let weaponOffered = 0
  bus.on(8, () => {})
  const timeline = []
  let nextMark = 10
  const bot = makeBot(aim, seed ^ 0x5f3759df)
  let t = 0
  let bossStart = -1
  let peakDps = 0
  while (t < 300 && w.state !== STATE.WON && w.state !== STATE.LOST) {
    const dx = bot.decide(w, FIXED_DT)
    runStep(w, FIXED_DT, dx)
    bus.drain()
    bus.clear()
    if (trace && t >= nextMark) {
      nextMark += 10
      timeline.push(`t${Math.round(t)}: n=${w.count} tier=${w.tier} dps=${Math.round(w.nominalDPS)} `
        + `par=${Math.round(parDPS(w.runTime))} z=${w.zombies.size} props=${w.props.size}`)
    }
    t += FIXED_DT
    if (w.state === STATE.BOSS && bossStart < 0) bossStart = t
    if (w.nominalDPS > peakDps) peakDps = w.nominalDPS
  }
  return {
    causes, timeline, weaponUps,
    aim,
    outcome: w.state === STATE.WON ? 'WIN' : w.state === STATE.LOST ? 'LOSS' : 'TIMEOUT',
    t: t.toFixed(1),
    atBoss: bossStart > 0 ? (t - bossStart).toFixed(1) : '-',
    count: w.count,
    peak: w.stats.peakCount,
    tier: w.tier,
    dps: Math.round(peakDps),
    bossHp: w.boss.maxHp ? Math.round((w.boss.hp / w.boss.maxHp) * 100) : '-',
    kills: w.stats.kills,
    took: w.stats.bubblesTaken,
    missed: w.stats.bubblesMissed,
    breached: w.stats.barrelsBreached,
    lost: w.stats.soldiersLost,
  }
}

assertFirewall()
deriveConfig(430, 900)
validateConfig()
console.log('config: OK\n')

const LEVELS = [
  ['EXPERT', 0.95], ['GOOD', 0.86], ['COMPETENT', 0.78],
  ['SHAKY', 0.69], ['CLUMSY', 0.58], ['BAD', 0.40],
]

console.log('skill      aim  outcome   run    boss  peak end tier  dps  boss%  kills  bub+/- brch lost')
console.log('-'.repeat(96))
for (const [name, aim] of LEVELS) {
  // Average behaviour across seeds, but print one representative run.
  let wins = 0
  const runs = []
  for (let s = 0; s < 5; s++) {
    const r = simulate(aim, 1000 + s * 7919)
    runs.push(r)
    if (r.outcome === 'WIN') wins++
  }
  const r = runs[0]
  console.log(
    name.padEnd(10), String(aim).padStart(4), r.outcome.padEnd(8),
    String(r.t).padStart(6), String(r.atBoss).padStart(6),
    String(r.peak).padStart(5), String(r.count).padStart(3),
    String(r.tier).padStart(4), String(r.dps).padStart(5),
    String(r.bossHp).padStart(5), String(r.kills).padStart(6),
    (r.took + '/' + r.missed).padStart(7), String(r.breached).padStart(4),
    String(r.lost).padStart(4), '   wins ' + wins + '/5',
  )
}


console.log('\n--- loss causes (sum over 5 seeds) ---')
for (const [name, aim] of LEVELS) {
  const tot = { zombie: 0, breach: 0, shock: 0, boss: 0 }
  for (let s = 0; s < 5; s++) {
    const r = simulate(aim, 1000 + s * 7919)
    for (const k of Object.keys(tot)) tot[k] += r.causes[k]
  }
  console.log(name.padEnd(10), Object.entries(tot).map(([k, v]) => k + '=' + v).join('  '))
}

console.log('\n--- weapon axis: upgrades actually taken (of 3 offered) ---')
for (const [name, aim] of LEVELS) {
  const ups = []
  for (let s = 0; s < 5; s++) ups.push(simulate(aim, 1000 + s * 7919).weaponUps)
  console.log(name.padEnd(10), 'tier-ups per run:', ups.join(' '))
}

console.log('\n--- representative timeline (COMPETENT, seed 1000) ---')
console.log(simulate(0.78, 1000, true).timeline.join('\n'))
