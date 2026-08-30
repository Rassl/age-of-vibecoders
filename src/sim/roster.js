/**
 * The single choke point for soldierCount.
 *
 * Every add and remove is QUEUED and applied once per substep. Without this, a
 * breach costing four soldiers fires four counter punches, four vignette pulses,
 * four haptics and four formation reshuffles in one step.
 */
import { CFG } from '../config.js'
import { squadDPS, formationSlot } from '../curves.js'
import { bus, T } from '../core/bus.js'
import { STATE } from './world.js'

export const CAUSE = { NONE: 0, ZOMBIE: 1, BREACH: 2, SHOCKWAVE: 3, BOSS: 4, BUBBLE: 5 }

const scratchSlot = { x: 0, z: 0 }

export function pendingCount(w) {
  return w.count + w.pendingAdds - w.pendingRemoves
}

export function queueAdd(w, n) {
  const room = CFG.squad.maxCount - pendingCount(w)
  const take = Math.max(0, Math.min(n, room))
  w.pendingAdds += take
  return take
}

export function queueRemove(w, n, cause) {
  // Never over-remove: proportional penalties are computed against pendingCount.
  const take = Math.max(0, Math.min(n, pendingCount(w)))
  w.pendingRemoves += take
  if (take > 0 && cause > w.lossCause) w.lossCause = cause
  return take
}

/** Spawn soldiers directly (run start and joiner merges). */
export function spawnSoldier(w, x, z) {
  const s = w.soldiers.acquire()
  if (!s) return null
  s.dead = false
  s.x = x; s.z = z
  s.fireTimer = w.rng.next() * 0.4
  s.iframe = 0
  s.recoil = 0; s.recoilVel = 0
  s.vx = x; s.vz = z
  s.lean = 0
  s.phase = w.rng.next() * 0.35          // NARROW spread: a trained unit, not a mob
  s.scale = 0.96 + w.rng.next() * 0.08
  s.jitterX = (w.rng.next() - 0.5) * 2 * CFG.formation.slotJitter
  s.jitterZ = (w.rng.next() - 0.5) * 2 * CFG.formation.slotJitter
  w.count = w.soldiers.size
  return s
}

/**
 * Apply every queued change ONCE, reassign slots once, emit exactly one
 * COUNT_CHANGED carrying the net delta and the dominant cause.
 */
export function commit(w) {
  const adds = w.pendingAdds
  const removes = w.pendingRemoves
  if (adds === 0 && removes === 0) {
    if (w.formationDirty) reassignSlots(w)
    return
  }
  w.pendingAdds = 0
  w.pendingRemoves = 0

  const before = w.count

  for (let i = 0; i < adds; i++) {
    const s = spawnSoldier(w, w.anchorX + (w.rng.next() - 0.5) * 0.6, (w.rng.next() - 0.5) * 0.6)
    if (!s) break
  }

  // Remove from the OUTSIDE IN: the soldier at the edge of the crowd is the one
  // that dies, which makes losses read as directional rather than arbitrary.
  for (let i = 0; i < removes && w.soldiers.size > 0; i++) {
    let worst = 0
    let worstD = -1
    for (let j = 0; j < w.soldiers.size; j++) {
      const s = w.soldiers.items[j]
      const dx = s.x - w.anchorX
      const d = dx * dx + s.z * s.z
      if (d > worstD) { worstD = d; worst = j }
    }
    const s = w.soldiers.items[worst]
    bus.emit(T.SOLDIER_LOSS, s.x, 0, s.z, w.lossCause)
    w.soldiers.release(worst)
    s.gen++
  }

  w.count = w.soldiers.size
  const delta = w.count - before
  if (delta > 0) w.stats.soldiersGained += delta
  if (delta < 0) w.stats.soldiersLost -= delta
  if (w.count > w.stats.peakCount) w.stats.peakCount = w.count

  reassignSlots(w)
  bus.emit(T.COUNT_CHANGED, w.anchorX, 0, 0, delta, w.count, 0, w.lossCause)
  w.lossCause = CAUSE.NONE

  // The ONE fail condition. The 0.55s i-frame caps bleed at 1.82/s and the 60%
  // breach cap means no single event wipes a squad of >= 2, so reaching zero
  // always takes sustained failure and is always narratable.
  if (w.count <= 0 && w.state === STATE.RUNNING) {
    w.state = STATE.LOST
    bus.emit(T.RUN_OVER, 0, 0, 0, 0)
  } else if (w.count <= 0 && w.state === STATE.BOSS) {
    w.state = STATE.LOST
    bus.emit(T.RUN_OVER, 0, 0, 0, 0)
  }
}

/**
 * Distance-sort survivors, then assign phyllotaxis slots in order so the
 * soldiers already nearest the centre keep the centre slots and the crowd
 * barely moves. Slot i is a pure function of index, so gaining soldier N never
 * displaces 0..N-1.
 */
export function reassignSlots(w) {
  const n = w.soldiers.size
  const items = w.soldiers.items
  // Insertion sort by squared distance from the anchor -- near-sorted every frame.
  for (let i = 1; i < n; i++) {
    const s = items[i]
    const d = dist2(s, w)
    let j = i - 1
    while (j >= 0 && dist2(items[j], w) > d) { items[j + 1] = items[j]; j-- }
    items[j + 1] = s
  }
  for (let i = 0; i < n; i++) {
    const s = items[i]
    s.slot = i
    formationSlot(i, n, scratchSlot)
    s.slotX = scratchSlot.x + s.jitterX
    s.slotZ = scratchSlot.z + s.jitterZ
  }
  w.formationDirty = false
  w.nominalDPS = squadDPS(w.count, w.tier)
}

function dist2(s, w) {
  const dx = s.x - w.anchorX
  return dx * dx + s.z * s.z
}

export function upgradeWeapon(w) {
  if (w.tier >= CFG.bubble.maxTier) return false
  w.tier++
  w.stats.tierUps++
  w.nominalDPS = squadDPS(w.count, w.tier)
  bus.emit(T.WEAPON_UP, w.anchorX, 1.2, 0, w.tier)
  return true
}
