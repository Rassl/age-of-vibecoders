/**
 * TICK ORDER IS DATA.
 *
 * The order below is the whole simulation, and every entry's position is a
 * decision with a failure mode attached (documented at each step). Exporting it
 * as a flat array lets the debug overlay toggle systems BY NAME to bisect a
 * gameplay bug in thirty seconds.
 */
import { CFG, FIXED_DT } from '../config.js'
import { scrollSpeed } from '../curves.js'
import { steer, steerTurret, resolveSquadPositions } from './steer.js'
import { autopilot } from './autopilot.js'
import { moveZombies, moveSpits, resolveBlasts } from './zombies.js'
import { moveJoiners } from './squad.js'
import { updateDrones, moveBolts } from './drones.js'
import { updateBoss, moveShockwaves, checkBossDeath } from './boss.js'
import { rebuildTargets } from './targets.js'
import { fire, fireTurret, resolveImpacts, flushDamage } from './combat.js'
import { collide, collideShockwaves } from './collision.js'
import { resolveCrossings, resolveBreaks, updateDisplayHp } from './props.js'
import { commit } from './roster.js'
import { direct } from './director.js'
import { STATE, MODE } from './world.js'
import { snapshot } from './interpolate.js'
import { updateWings } from './wings.js'

/** Advance run time and settle THIS step's scroll speed, once, for everyone. */
function timeSystem(w, dt) {
  w.runTime += dt
  if (w.state === STATE.BOSS || w.state === STATE.WON) {
    // The world decelerates to a stop under the boss.
    w.scroll += (w.scrollTarget - w.scroll) * (1 - Math.exp(-dt / CFG.boss.entryDecel))
    if (w.scroll < 0.05) w.scroll = 0
  } else {
    // HOLDOUT: the squad is planted, so nothing treadmills -- the horde closes
    // under its own speed (zombies.js applies the mode's speed boost).
    w.scroll = w.mode === MODE.HOLDOUT ? 0 : scrollSpeed(w.runTime)
  }
  w.distance += w.scroll * dt
}

/**
 * One pass moving the whole world toward the squad. BEFORE collision, never
 * after: move-after-test gives a barrel one free frame of overlap, which is
 * exactly the one-frame unfairness players read as the game cheating.
 */
function scrollSystem(w, dt) {
  const d = w.scroll * dt
  const despawn = CFG.world.despawnZ

  // HOLDOUT: the road is frozen (scroll 0) but the hazard/reward lanes still
  // close on the squad -- barrels, gates and bubbles drift in at leg-ish speed,
  // so "everything comes to you" includes the economy, not just the horde.
  const dProp = w.mode === MODE.HOLDOUT ? CFG.holdout.propSpeed * dt : d

  const ps = w.props
  for (let i = 0; i < ps.size; i++) {
    const p = ps.items[i]
    p.z += dProp
    if (p.z > despawn) p.dead = true
  }
  const zs = w.zombies
  for (let i = 0; i < zs.size; i++) zs.items[i].z += d
  const js = w.joiners
  for (let i = 0; i < js.size; i++) js.items[i].z += d
  const ss = w.shockwaves
  for (let i = 0; i < ss.size; i++) ss.items[i].z += d
}

/**
 * Two-phase death, resolved here and only here. Walk BACKWARDS so swap-remove
 * never pulls an unvisited entity out from under the iteration, and bump each
 * slot's generation so a deferred impact cannot damage a recycled entity.
 */
function reapSystem(w) {
  reapPool(w.zombies)
  reapPool(w.spits)
  reapPool(w.props)
  reapPool(w.joiners)
  reapPool(w.shockwaves)
  reapPool(w.drones)
  reapPool(w.bolts)
}

function reapPool(pool) {
  for (let i = pool.size - 1; i >= 0; i--) {
    const e = pool.items[i]
    if (!e.dead) continue
    e.gen++
    e.touched = false
    e.pending = 0
    // Cross-prop links must not survive into the next occupant of this slot:
    // Pool.acquire hands the same object back, so a stale gatedBy would make a
    // fresh bubble look permanently gated by a barrel that no longer exists.
    if (e.gate !== undefined) e.gate = null
    if (e.gatedBy !== undefined) e.gatedBy = null
    // Same rule for the gate row links: a recycled slot must not keep tugging
    // width from a row that no longer exists.
    if (e.rowL !== undefined) e.rowL = null
    if (e.rowR !== undefined) e.rowR = null
    pool.release(i)
  }
}

/**
 * Who gets the drag. In TURRET mode the finger aims the gun and the squad
 * drives itself: the pilot returns a displacement in the same units the
 * finger would, and steer() consumes it under the same velocity model, so
 * "the squad moves on its own" costs no second movement code path.
 */
function steerSystem(w, dt, dx, axis) {
  if (w.mode === MODE.TURRET) {
    steerTurret(w, dt, dx, axis)
    steer(w, dt, autopilot(w, dt), 0)
    return
  }
  steer(w, dt, dx, axis)
}

export const SYSTEMS = [
  { name: 'time', fn: timeSystem },
  // Right after time: the altitude this step is settled before anything that
  // reads it (muzzle heights in fire, contact immunity in collision).
  { name: 'wings', fn: updateWings },
  { name: 'steer', fn: steerSystem },
  { name: 'formation', fn: (w) => resolveSquadPositions(w) },
  { name: 'scroll', fn: scrollSystem },
  { name: 'zombies', fn: moveZombies },
  { name: 'spits', fn: moveSpits },
  { name: 'joiners', fn: moveJoiners },
  // Drones aim and bolts fly BEFORE targets/fire, so a bolt queued this step is
  // settled by the same flushDamage pass as the squad's own shots. Running them
  // after would put every drone hit one full step behind its own explosion.
  { name: 'drones', fn: updateDrones },
  { name: 'bolts', fn: moveBolts },
  { name: 'shockwaves', fn: moveShockwaves },
  { name: 'boss', fn: updateBoss },
  { name: 'targets', fn: (w) => rebuildTargets(w) },
  { name: 'fire', fn: fire },
  // Same blocker index, same ledger, same flush: a turret round and a squad
  // round converging on one walker are settled together and its death is
  // detected exactly once.
  { name: 'turret', fn: fireTurret },
  { name: 'impacts', fn: (w) => resolveImpacts(w) },
  { name: 'damage', fn: (w) => flushDamage(w) },
  // A bloater's blast is queued as ordinary damage and settled by a second
  // flush, so a chain resolves one link per step instead of recursing.
  { name: 'blasts', fn: (w) => resolveBlasts(w) },
  { name: 'damage2', fn: (w) => flushDamage(w) },
  { name: 'breaks', fn: (w) => resolveBreaks(w) },
  { name: 'collision', fn: collide },
  { name: 'shockHits', fn: collideShockwaves },
  { name: 'crossings', fn: (w) => resolveCrossings(w) },
  { name: 'roster', fn: (w) => commit(w) },
  { name: 'bossDeath', fn: (w) => checkBossDeath(w) },
  { name: 'display', fn: updateDisplayHp },
  { name: 'reap', fn: (w) => reapSystem(w) },
  { name: 'director', fn: direct },
]

/** Systems disabled by the debug overlay, by name. */
export const disabled = new Set()

export function runStep(w, dt, dx, axis = 0) {
  if (w.state === STATE.READY || w.state === STATE.WON || w.state === STATE.LOST) return
  // Record where everything was, so the renderer can draw the in-between frames.
  snapshot(w)
  for (let i = 0; i < SYSTEMS.length; i++) {
    const s = SYSTEMS[i]
    if (disabled.has(s.name)) continue
    s.fn(w, dt, dx, axis)
  }
}

export { FIXED_DT }
