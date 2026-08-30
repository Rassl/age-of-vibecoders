/**
 * Escort drones and their bolts.
 *
 * THE ONE THING IN THE GAME THAT DOES NOT FIRE STRAIGHT. Every soldier casts
 * along -Z and the player aims with the squad's body; the drone picks a target
 * anywhere in front and lobs a bolt at it. That is the entire point of the
 * pickup -- it answers a threat standing in a lane you are not in -- and it is
 * also exactly why the drone is on a timer. A permanent off-axis turret retires
 * the mode's premise, so `lifetime` is the load-bearing number here, not `dpsFrac`.
 *
 * Bolts HOME, within a turn-rate limit. Aiming at a predicted point instead was
 * measured landing zero hits per burst: the squad's own fire kills a walker in
 * well under a bolt's flight time, so the bolt would arrive at a spot the target
 * had already died in. Homing costs a generation check per step and is worth it.
 * A bolt whose target dies mid-flight keeps its last heading and can still catch
 * something on proximity, which is what the blast radius is for.
 */
import { CFG } from '../config.js'
import { parDPS } from '../curves.js'
import { bus, T } from '../core/bus.js'
import { queueDamage } from './combat.js'

/** Aim height. Bodies are ~1.5u tall; the chest is what reads as a hit. */
const CHEST_Y = 0.75

export function spawnDrone(w, permanent = false) {
  const d = CFG.drone
  // Refresh rather than stack past the cap: a third pickup tops the pair back up
  // to full life, which reads as "my drones got stronger" instead of silently
  // discarding the reward.
  if (w.drones.size >= d.maxActive) {
    let oldest = null
    for (let i = 0; i < w.drones.size; i++) {
      const c = w.drones.items[i]
      // Never refresh the permanent escort: its life never falls, so it would
      // otherwise be picked as "oldest" only by accident, and topping it up
      // silently discards the pickup the player just paid a toll for.
      if (c.permanent) continue
      if (!oldest || c.life < oldest.life) oldest = c
    }
    if (oldest) {
      oldest.life = d.lifetime
      oldest.maxLife = d.lifetime
      bus.emit(T.DRONE_SPAWN, oldest.x, oldest.y, oldest.z, oldest.slot)
    }
    return oldest
  }

  const dr = w.drones.acquire()
  if (!dr) return null
  dr.dead = false
  dr.permanent = permanent
  // Carried per drone, not read globally at fire time, so a permanent escort and
  // a bought one can coexist at different strengths.
  dr.dpsFrac = permanent ? d.startDpsFrac : d.dpsFrac
  dr.slot = w.drones.size - 1
  // Spread the orbit phase across the active drones so they sit on opposite
  // sides of the squad instead of overlapping into one blob.
  dr.phase = (dr.slot / Math.max(1, d.maxActive)) * Math.PI * 2
  dr.life = d.lifetime
  dr.maxLife = d.lifetime
  dr.fireTimer = 0
  dr.hasTarget = false
  dr.x = w.anchorX
  dr.y = d.height
  dr.z = CFG.world.squadZ + 1.2
  bus.emit(T.DRONE_SPAWN, dr.x, dr.y, dr.z, dr.slot)
  return dr
}

export function updateDrones(w, dt) {
  const d = CFG.drone
  const pool = w.drones
  const par = parDPS(w.runTime)

  for (let i = pool.size - 1; i >= 0; i--) {
    const dr = pool.items[i]
    if (dr.dead) continue

    if (!dr.permanent) dr.life -= dt
    if (dr.life <= 0) {
      dr.dead = true
      bus.emit(T.DRONE_EXPIRE, dr.x, dr.y, dr.z, dr.slot)
      continue
    }

    dr.phase += dt * d.orbitHz * Math.PI * 2
    const tx = w.anchorX + Math.cos(dr.phase) * d.orbitRadius
    const tz = CFG.world.squadZ + 1.2 + Math.sin(dr.phase) * 0.8
    const k = 1 - Math.exp(-dt / Math.max(1e-4, d.followTau))
    dr.x += (tx - dr.x) * k
    dr.z += (tz - dr.z) * k
    dr.y = d.height + Math.sin(dr.phase * (d.bobHz / Math.max(1e-4, d.orbitHz))) * d.bobAmp

    dr.fireTimer -= dt
    if (dr.fireTimer > 0) continue

    const target = pickTarget(w, dr)
    if (!target) { dr.hasTarget = false; continue }
    dr.hasTarget = true
    dr.aimX = target.x
    dr.aimZ = target.z
    dr.fireTimer = 1 / d.fireRate
    fireBolt(w, dr, target, (par * dr.dpsFrac) / Math.max(0.01, d.fireRate))
  }
}

/**
 * What the drone shoots.
 *
 * Bodies AND barrels. Bodies only was the wrong answer and the harness said so:
 * swapping a soldiers reward for a drone strictly lowers survivability, because
 * a soldier is damage AND hit points while a drone is damage alone. Raising
 * dpsFrac did not fix it -- 0.55 through 1.50 moved the win rate 13 -> 17/30 and
 * then flatly saturated, because the runs were being lost to BREACH, and no
 * amount of anti-body damage answers a barrel. So the drone shoots the thing
 * that is actually killing you.
 *
 * Barrels are scored by IMMINENCE rather than distance: a wall four seconds out
 * with full hp is worth more attention than a walker at the same range.
 */
function pickTarget(w, dr) {
  const d = CFG.drone
  let best = null
  let bestScore = Infinity

  const zs = w.zombies
  for (let i = 0; i < zs.size; i++) {
    const z = zs.items[i]
    if (z.dead || z.z > 0.4) continue
    const dz = dr.z - z.z
    if (dz <= 0 || dz > d.range) continue
    const offAxis = Math.abs(z.x - w.anchorX)
    // Distance is the cost. Two discounts, both aimed at the same thing: spend
    // the drone on what the squad is NOT already deleting. Off the firing line
    // is one; durable enough to still be alive when the bolt lands is the other,
    // and without it the drone spends most of its life shooting walkers that
    // died to rifle fire mid-flight.
    const score = dz - Math.min(offAxis, 4.5) * 2.2 - Math.min(z.hp, 260) * 0.05
    if (score < bestScore) { bestScore = score; best = z }
  }

  const ps = w.props
  for (let i = 0; i < ps.size; i++) {
    const p = ps.items[i]
    // Gates carry no hp and are not shootable by the drone; a bubble is the
    // player's decision to make, so the drone never pops one uninvited.
    if (p.dead || p.kind !== 'barrel' || p.hp <= 0) continue
    const dz = dr.z - p.z
    if (dz <= 0 || dz > d.range) continue
    // Only what the squad is actually about to run into: a barrel the player
    // has already steered clear of is not the drone's problem.
    if (Math.abs(p.x - w.anchorX) > p.halfW + CFG.barrel.dodgeTestRadius + 1.0) continue
    const score = dz - d.barrelBias
    if (score < bestScore) { bestScore = score; best = p }
  }
  if (best) return best

  const boss = w.boss
  if (boss.active && !boss.dead && dr.z - boss.z < d.range) return boss
  return null
}

function fireBolt(w, dr, target, damage) {
  const d = CFG.drone
  const b = w.bolts.acquire()
  if (!b) return
  b.dead = false
  b.x = dr.x
  b.y = dr.y
  b.z = dr.z
  b.damage = damage
  b.life = d.boltLife
  b.tref = target
  b.tgen = target.gen

  // NO LEAD. A homing bolt does not need one, and solving for an intercept here
  // actively broke it: the closing speed (scroll + walk, ~20u/s) is the same
  // order as the bolt speed (30u/s), so the fixed-point solve OSCILLATES rather
  // than converging, and three iterations landed on an arbitrary aim point up to
  // 15u from any body. Fire straight at the target and let the steering close it.
  aimAt(b, target, d)
  bus.emit(T.DRONE_FIRE, dr.x, dr.y, dr.z, dr.slot)
}

/** Point the bolt's velocity at a target's chest, preserving its speed. */
function aimAt(b, target, d) {
  const tx = target.x
  const ty = CHEST_Y
  const tz = target.z
  const dx = tx - b.x
  const dy = ty - b.y
  const dz = tz - b.z
  const len = Math.hypot(dx, dy, dz) || 1
  b.tx = tx
  b.tz = tz
  b.vx = (dx / len) * d.boltSpeed
  b.vy = (dy / len) * d.boltSpeed
  b.vz = (dz / len) * d.boltSpeed
}

export function moveBolts(w, dt) {
  const d = CFG.drone
  const pool = w.bolts
  const arrive = d.blastRadius * d.proximityFrac
  for (let i = pool.size - 1; i >= 0; i--) {
    const b = pool.items[i]
    if (b.dead) continue

    // Re-home while the target lives. The generation check is what makes a
    // stale reference safe: pool slots are recycled, so without it a bolt could
    // chase whatever body inherited its target's slot.
    const t = b.tref
    const alive = t && !t.dead && t.gen === b.tgen
    if (alive) {
      const turn = 1 - Math.exp(-dt / Math.max(1e-4, d.homingTau))
      const dx = t.x - b.x
      const dy = CHEST_Y - b.y
      const dz = t.z - b.z
      const len = Math.hypot(dx, dy, dz) || 1
      b.vx += ((dx / len) * d.boltSpeed - b.vx) * turn
      b.vy += ((dy / len) * d.boltSpeed - b.vy) * turn
      b.vz += ((dz / len) * d.boltSpeed - b.vz) * turn
      // Renormalise: steering must never change the bolt's speed.
      const sl = Math.hypot(b.vx, b.vy, b.vz) || 1
      const k = d.boltSpeed / sl
      b.vx *= k; b.vy *= k; b.vz *= k
      b.tx = t.x
      b.tz = t.z
    } else {
      b.tref = null
    }

    b.x += b.vx * dt
    b.y += b.vy * dt
    b.z += b.vz * dt
    b.life -= dt

    // Arrived, ran out, hit the road, or drifted close enough to something else.
    const dx = b.tx - b.x
    const dz = b.tz - b.z
    const reached = dx * dx + dz * dz <= arrive * arrive
    // Proximity only counts when the bolt is chasing a BODY. A bolt sent at a
    // barrel must not go off early on a walker standing in front of it, or the
    // drone can never actually break the thing it was aimed at.
    const chasingBarrel = b.tref !== null && b.tref.kind === 'barrel'
    if (reached || b.life <= 0 || b.y < 0.12 || (!chasingBarrel && nearAnyBody(w, b))) {
      detonate(w, b)
      b.tref = null
      b.dead = true
    }
  }
}

/** Is the bolt already close enough to a live body to be worth going off? */
function nearAnyBody(w, b) {
  const r = CFG.drone.blastRadius * CFG.drone.proximityFrac
  const r2 = r * r
  const zs = w.zombies
  for (let i = 0; i < zs.size; i++) {
    const z = zs.items[i]
    if (z.dead) continue
    const dx = z.x - b.x
    const dz = z.z - b.z
    if (dx * dx + dz * dz <= r2) return true
  }
  return false
}

function detonate(w, b) {
  const r = CFG.drone.blastRadius
  const r2 = r * r
  const zs = w.zombies
  let hit = 0
  for (let i = 0; i < zs.size; i++) {
    const z = zs.items[i]
    if (z.dead) continue
    const dx = z.x - b.x
    const dz = z.z - b.z
    if (dx * dx + dz * dz > r2) continue
    queueDamage(w, z, b.damage)
    hit++
  }
  const boss = w.boss
  if (boss.active && !boss.dead) {
    const dx = boss.x - b.x
    const dz = boss.z - b.z
    if (dx * dx + dz * dz <= (r + CFG.boss.radius) * (r + CFG.boss.radius)) {
      queueDamage(w, boss, b.damage)
      hit++
    }
  }

  // The barrel it was aimed at, explicitly rather than by area. An AoE over
  // props would let one bolt clip a neighbouring lane's toll and quietly open a
  // gate the player never paid for.
  const t = b.tref
  if (t && !t.dead && t.gen === b.tgen && t.kind === 'barrel') {
    const dx = t.x - b.x
    const dz = t.z - b.z
    if (dx * dx + dz * dz <= (r + t.halfW) * (r + t.halfW)) {
      queueDamage(w, t, b.damage)
      hit++
    }
  }
  // Tracked so the pickup's real contribution is measurable rather than assumed:
  // a drone that looks busy but lands 2% of a run's damage is decoration.
  w.stats.droneDamage += b.damage * hit
  w.stats.droneBursts++
  w.stats.droneHits += hit
  bus.emit(T.BOLT_BURST, b.x, Math.max(0.2, b.y), b.z, hit)
}
