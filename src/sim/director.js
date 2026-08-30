/**
 * Content spawning. Runs LAST in the substep, deliberately: new content is
 * priced against the squad the player ACTUALLY has, which roster.commit only
 * finalised a moment ago. Spawning first would price this window's barrels
 * against last step's squad -- precisely the asymmetry the economy depends on.
 *
 * It also guarantees a freshly spawned entity is never moved, shot or collided
 * in the step it was created, so the 72u horizon is exact rather than
 * approximate -- and that horizon is the budget the whole economy is written
 * against.
 */
import { CFG } from '../config.js'
import { BEATS, GATE_ROWS, SWEEPS, SWEEP_GAP, BUBBLE_TRAIL } from '../data/encounters.js'
import { rollEnemyKind } from '../data/enemies.js'
import { spawnRate } from '../curves.js'
import { spawnZombie } from './zombies.js'
import { spawnBarrel, spawnBubble, spawnGate } from './props.js'
import { triggerBoss } from './boss.js'
import { bus, T } from '../core/bus.js'
import { STATE } from './world.js'

export function direct(w, dt) {
  if (w.state !== STATE.RUNNING) {
    if (w.state === STATE.BOSS) spawnCrowd(w, dt, 0.35)
    return
  }

  const t = w.runTime
  const horizon = -CFG.world.spawnHorizon

  while (w.beatCursor < BEATS.length && BEATS[w.beatCursor].t <= t) {
    spawnBeat(w, BEATS[w.beatCursor], horizon)
    w.beatCursor++
  }

  while (w.gateCursor < GATE_ROWS.length && GATE_ROWS[w.gateCursor].t <= t) {
    spawnGateRow(w, GATE_ROWS[w.gateCursor].segments)
    w.gateCursor++
  }

  while (w.sweepCursor < SWEEPS.length && SWEEPS[w.sweepCursor].t <= t) {
    spawnSweep(w, SWEEPS[w.sweepCursor], horizon)
    w.sweepCursor++
  }

  spawnCrowd(w, dt, 1)

  if (t >= CFG.world.runSeconds) triggerBoss(w)
}

function spawnBeat(w, beat, horizon) {
  bus.emit(T.BEAT, 0, 0, horizon, beat.t)
  if (beat.kind === 'pair') {
    for (const lane of beat.lanes) {
      let gate = null
      if (lane.toll) gate = spawnBarrel(w, lane.toll.role, lane.x, horizon, lane.toll.hpScale)
      const bubble = spawnBubble(w, lane.x, horizon - BUBBLE_TRAIL, lane.reward)
      if (gate && bubble) { gate.gate = bubble; bubble.gatedBy = gate }
    }
  } else if (beat.kind === 'gates') {
    spawnGateRow(w, beat.segments)
  } else if (beat.kind === 'wall') {
    spawnBarrel(w, 'wall', 0, horizon, beat.hpScale)
  } else if (beat.kind === 'cheap') {
    for (const lane of beat.lanes) spawnBarrel(w, 'cheap', lane.x, horizon, lane.hpScale)
  }
}

/**
 * One row of gate segments, TILED across the corridor with no gaps.
 *
 * Segments are authored as relative weights and sized here from the live
 * corridor width, so the row always spans rail to rail: a gap would let the
 * squad slip through paying nothing, which quietly deletes the decision. The
 * crossing test in props.js is strict containment, so tiling also guarantees
 * the squad is billed by exactly one segment.
 */
function spawnGateRow(w, segments) {
  let total = 0
  for (const g of segments) total += (g.w || 1)
  const span = CFG.world.clampX * 2
  const inset = CFG.gate.rowInset
  let cursor = -CFG.world.clampX
  for (const g of segments) {
    const width = ((g.w || 1) / total) * span
    // The visual panel is inset slightly so neighbouring segments read as two
    // gates with a post between them, but halfW -- the BILLING extent -- keeps
    // the full untrimmed width so the seam is not a dead zone.
    spawnGate(w, cursor + width * 0.5, CFG.gate.spawnZ, g.v, width * 0.5)
    cursor += width
  }
  void inset
}

/** A scripted river of runners occupying most of the corridor: pure movement. */
function spawnSweep(w, sweep, horizon) {
  const half = CFG.world.railX - 0.5
  for (let i = 0; i < sweep.count; i++) {
    const x = -half + (i / (sweep.count - 1)) * half * 2
    if (Math.abs(x - sweep.gapX) < SWEEP_GAP) continue
    spawnZombie(w, 'runner', x, horizon - (i % 3) * 2.5)
  }
}

/**
 * Continuous horde pressure, driven by the threat curve.
 *
 * Bodies arrive in CLUSTERS rather than one at a time. The rate -- and therefore
 * the threat -- is identical, but a crowd that walks in as clumps reads as a
 * horde, while the same bodies dribbled in one per 300ms read as a trickle that
 * the squad deletes on contact. This is a presentation property enforced in the
 * sim because it changes which bodies are alive at once, not merely how they look.
 */
function spawnCrowd(w, dt, mult) {
  const rate = spawnRate(w.runTime, Math.max(w.nominalDPS, 30)) * mult
  w.spawnCredit += rate * dt
  const horizon = -CFG.world.spawnHorizon
  const size = CLUSTER_SIZE
  if (w.spawnCredit < size) return

  let guard = 0
  while (w.spawnCredit >= size && guard++ < 4) {
    w.spawnCredit -= size
    // One cluster centre, biased toward the squad so the crowd is a real
    // obstacle rather than scenery drifting past the railings.
    const centre = (w.rng.next() < 0.6 ? w.anchorX : 0) +
      (w.rng.next() - 0.5) * CFG.threat.clusterSpread * 2
    for (let i = 0; i < size; i++) {
      const kind = rollEnemyKind(w.runTime, w.rng)
      const x = centre + (w.rng.next() - 0.5) * CFG.threat.clusterWidth * 2
      spawnZombie(w, kind, x, horizon - w.rng.next() * 7)
    }
  }
}

const CLUSTER_SIZE = 4
