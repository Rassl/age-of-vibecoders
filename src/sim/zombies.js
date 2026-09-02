/**
 * The horde. Walkers are the baseline crowd; the threat is VOLUME and bullet
 * blocking, never individual toughness -- HP scales far slower than squad DPS
 * on purpose, so crowds get bigger rather than tankier.
 */
import { CFG } from '../config.js'
import { ENEMIES } from '../data/enemies.js'
import { zombieHP } from '../curves.js'
import { clamp } from '../util/math.js'
import { bus, T } from '../core/bus.js'
import { queueRemove, CAUSE } from './roster.js'
import { queueDamage } from './combat.js'
import { MODE } from './world.js'

export function spawnZombie(w, kind, x, z) {
  const z0 = w.zombies.acquire()
  if (!z0) return null
  const e = ENEMIES[kind]
  z0.dead = false
  z0.kind = kind
  z0.x = clamp(x, -CFG.world.railX + 0.4, CFG.world.railX - 0.4)
  z0.z = z
  z0.maxHp = zombieHP(w.runTime, kind)
  z0.hp = z0.maxHp
  // In holdout there is no scroll under the horde, so their own legs carry the
  // whole approach; the boost keeps pressure at the squad near advance-mode.
  z0.speed = e.speed * (w.mode === MODE.HOLDOUT ? CFG.holdout.speedMult : 1)
  z0.radius = e.radius
  z0.kills = e.kills
  z0.scale = e.scale
  z0.cadence = e.cadence
  z0.phase = w.rng.next()
  z0.flash = 0
  z0.spawnT = w.runTime
  z0.pending = 0
  z0.touched = false
  z0.killedByPlayer = false
  z0.ranged = !!e.ranged
  z0.holding = false
  z0.windup = 0
  z0.reload = e.reload ? e.reload * (0.5 + w.rng.next() * 0.5) : 0
  z0.aimX = z0.x
  z0.explodes = !!e.explodes
  z0.blasted = false
  return z0
}

/**
 * Self-motion only -- the world scroll is applied to every entity in one pass
 * beforehand. Lateral homing is RATE-LIMITED so a zombie can be outrun sideways
 * but not trivially, and it homes on the squad's TRUE current x (steering has
 * already run this step).
 */
export function moveZombies(w, dt) {
  const pool = w.zombies
  const homing = CFG.zombie.lateralHoming * dt
  for (let i = 0; i < pool.size; i++) {
    const z = pool.items[i]
    if (z.dead) continue

    if (z.ranged) {
      updateSpitter(w, z, dt)
    } else {
      z.z += z.speed * dt
    }

    const dx = w.anchorX - z.x
    z.x += clamp(dx, -homing, homing)
    z.phase += z.cadence * dt
    if (z.flash > 0) z.flash = Math.max(0, z.flash - CFG.fx.hitFlashDecay * dt)
    if (z.z > CFG.world.despawnZ) z.dead = true
  }
}

/**
 * The spitter stops at a standoff distance and lobs acid.
 *
 * It is the only enemy that threatens the squad WITHOUT reaching it, so it
 * cannot be answered by sidestepping -- it has to be shot, which puts it in
 * direct competition with the barrel the player was aiming at. The windup is
 * long and visible on purpose: the threat has to be readable before it lands.
 */
function updateSpitter(w, z, dt) {
  const e = ENEMIES[z.kind]
  if (z.z < e.holdZ) {
    z.z += z.speed * dt
    z.holding = false
    return
  }
  // Hold STATION, which means swimming against the treadmill: the scroll pass
  // has already carried this zombie toward the squad this step, so a spitter
  // that merely stops advancing still sweeps past and never completes a windup.
  z.holding = true
  z.z -= w.scroll * dt
  if (z.windup > 0) {
    z.windup -= dt
    if (z.windup <= 0) {
      fireSpit(w, z)
      z.reload = e.reload
    }
    return
  }
  z.reload -= dt
  if (z.reload <= 0) {
    z.windup = e.windup
    z.aimX = w.anchorX          // it commits to your CURRENT lane, so moving beats it
    bus.emit(T.SPIT_WINDUP, z.x, 1.2, z.z)
  }
}

function fireSpit(w, z) {
  const s = w.spits.acquire()
  if (!s) return
  s.dead = false
  s.landed = false
  s.x = z.aimX
  s.y = 1.4
  s.z = z.z
  s.vz = CFG.zombie.spitSpeed
  s.t = 0
  bus.emit(T.SPIT_FIRE, z.x, 1.2, z.z, s.x)
}

/** Acid in flight. Travels straight down the corridor at the lane it committed to. */
export function moveSpits(w, dt) {
  const pool = w.spits
  for (let i = 0; i < pool.size; i++) {
    const s = pool.items[i]
    if (s.dead) continue
    s.z += s.vz * dt
    s.t += dt
    // A shallow arc: it rises then drops into the road at the squad plane.
    s.y = 1.4 + Math.sin(Math.min(1, s.t * 1.6) * Math.PI) * 1.1
    if (s.z >= CFG.world.squadZ) {
      s.dead = true
      const hit = Math.abs(s.x - w.anchorX) < CFG.zombie.spitRadius
      bus.emit(T.SPIT_LAND, s.x, 0, CFG.world.squadZ, hit ? 1 : 0)
      if (hit) queueRemove(w, CFG.zombie.spitKills, CAUSE.ZOMBIE)
    }
  }
}

/**
 * Bloater death blast.
 *
 * sim -> sim causality, so it is a direct call and never goes through the bus.
 * The blast is queued as ordinary damage and flushed by a SECOND damage pass in
 * the same step, which makes chains fall out for free: a bloater killed by
 * another bloater's blast simply explodes on the next step rather than needing
 * a recursive resolver that could run away.
 */
export function resolveBlasts(w) {
  const pool = w.zombies
  for (let i = 0; i < pool.size; i++) {
    const z = pool.items[i]
    if (!z.dead || !z.explodes || z.blasted) continue
    z.blasted = true
    const e = ENEMIES[z.kind]
    const r2 = e.blastRadius * e.blastRadius
    const dmg = z.maxHp * e.blastFrac
    for (let j = 0; j < pool.size; j++) {
      const o = pool.items[j]
      if (o === z || o.dead) continue
      const dx = o.x - z.x
      const dz = o.z - z.z
      if (dx * dx + dz * dz > r2) continue
      queueDamage(w, o, dmg)
    }
    bus.emit(T.BLOAT, z.x, 0.9, z.z, e.blastRadius)
  }
}
