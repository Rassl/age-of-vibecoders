/**
 * Joiners: reinforcements in transit.
 *
 * A joiner is a squad member in transit, so it lives here and shares the slot
 * allocator. It is invulnerable and non-colliding during the run-in -- a reward
 * that can be killed on the way in is a reward the player is punished for
 * earning -- and merges are staggered 60ms apart so the counter visibly TICKS UP.
 * Three simultaneous merges read as one event; staggered they read as three gains.
 */
import { CFG } from '../config.js'
import { bus, T } from '../core/bus.js'
import { queueAdd } from './roster.js'

export function spawnJoiners(w, x, y, z, n, stagger) {
  const gap = stagger === undefined ? CFG.bubble.joinerStagger : stagger
  let spawned = 0
  for (let i = 0; i < n; i++) {
    const j = w.joiners.acquire()
    if (!j) break
    j.dead = false
    j.x = x + (w.rng.next() - 0.5) * 0.5
    j.y = y
    j.z = z
    j.sx = j.x
    j.sz = j.z
    j.delay = i * gap
    j.t = 0
    spawned++
  }
  return spawned
}

export function moveJoiners(w, dt) {
  const pool = w.joiners
  const speed = CFG.bubble.joinerSpeed
  for (let i = pool.size - 1; i >= 0; i--) {
    const j = pool.items[i]
    if (j.dead) continue
    if (j.delay > 0) { j.delay -= dt; continue }
    j.t += dt

    const tx = w.anchorX
    const tz = CFG.world.squadZ
    const dx = tx - j.x
    const dz = tz - j.z
    const d = Math.hypot(dx, dz)
    if (d < 0.35 || j.t > 1.6) {
      // Merge: exactly one add, one ring flash, one +1 pop.
      // At the cap queueAdd returns 0; firing the pickup burst and sound anyway
      // promises a soldier the sim did not deliver.
      if (queueAdd(w, 1) > 0) bus.emit(T.SOLDIER_GAIN, tx, 0, tz)
      j.dead = true
      continue
    }
    const step = Math.min(speed * dt, d)
    j.x += (dx / d) * step
    j.z += (dz / d) * step
    j.y += (0.9 - j.y) * (1 - Math.exp(-dt / 0.12))
  }
}
