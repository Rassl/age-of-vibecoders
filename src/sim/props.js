/**
 * Barrels and bubbles -- the decision objects.
 *
 * A barrel BLOCKS BULLETS over its full x-extent, which is what makes a toll
 * literally gate the reward bubble behind it: you must break the barrel to
 * expose the bubble, then break the bubble, inside one window. You can afford
 * one lane.
 */
import { CFG } from '../config.js'
import { barrelHP, bubbleHP, breachLoss, gateLoss, soldiersPerBubble } from '../curves.js'
import { bus, T } from '../core/bus.js'
import { queueRemove, upgradeWeapon, CAUSE } from './roster.js'
import { spawnJoiners } from './squad.js'
import { spawnDrone } from './drones.js'
import { roleId } from './combat.js'
import { damp } from '../util/math.js'

export function spawnBarrel(w, role, x, z, hpScale) {
  const p = w.props.acquire()
  if (!p) return null
  p.dead = false
  p.kind = 'barrel'
  p.role = role
  p.x = role === 'wall' ? 0 : x
  p.z = z
  p.halfW = (role === 'wall' ? CFG.barrel.wallWidth : CFG.barrel.dodgeableWidth) / 2
  p.maxHp = barrelHP(role, w.runTime, w.nominalDPS, hpScale)
  p.hp = p.maxHp
  p.displayHp = p.maxHp
  p.flash = 0
  p.pending = 0
  p.touched = false
  p.resolved = false
  p.reward = null
  p.gate = null
  p.gatedBy = null
  p.beatT = w.runTime
  p.killedByPlayer = false
  return p
}

export function spawnBubble(w, x, z, reward, hpScale = 1) {
  const p = w.props.acquire()
  if (!p) return null
  p.dead = false
  p.kind = 'bubble'
  p.role = 'bubble'
  p.x = x
  p.z = z
  p.halfW = CFG.bubble.radius
  p.maxHp = bubbleHP(w.runTime, w.nominalDPS, hpScale)
  p.hp = p.maxHp
  p.displayHp = p.maxHp
  p.flash = 0
  p.pending = 0
  p.touched = false
  p.resolved = false
  p.reward = reward
  p.gate = null
  p.gatedBy = null
  p.beatT = w.runTime
  p.killedByPlayer = false
  return p
}

/**
 * A gate segment: a panel you DRIVE THROUGH, not one you shoot.
 *
 * hp stays 0 so rebuildTargets skips it and bullets pass straight through --
 * a gate that ate bullets would shield whatever is behind it, and the reference
 * clearly shoots barrels through the gate line.
 *
 * Segments are authored as a ROW that tiles the corridor: `x` is the segment
 * centre and `halfW` its half-width, and the crossing test uses strict
 * containment of the squad centroid so exactly one segment of a row can ever
 * bill. Widening the test by a dodge radius the way barrels do would let a
 * centroid near a seam trigger both neighbours.
 */
export function spawnGate(w, x, z, value, halfW) {
  const p = w.props.acquire()
  if (!p) return null
  p.dead = false
  p.kind = 'gate'
  p.role = value >= 0 ? 'boon' : 'bane'
  // PRICE THE PENALTY ONCE, HERE -- exactly like barrelHP prices a barrel at
  // spawn against the squad of the moment.
  //
  // The authored value used to be kept raw and capped at resolution time, with
  // the panel displaying the capped figure. That made shooting a plate feel
  // dead: with 16 soldiers a -14 plate displayed -5, and the first SEVEN points
  // of damage moved the internal value with no visible change at all. Worse, the
  // displayed number was a function of two moving variables -- the value AND the
  // live squad count -- so under sustained fire it read -5 -5 -5 -7 -8 -2, going
  // BACKWARDS while the player was shooting it. Capping at spawn makes the
  // displayed number the real number, and every point of damage move it by one.
  if (value < 0) value = -gateLoss(w.count, value)
  p.x = x
  p.z = z
  p.halfW = halfW
  p.maxHp = 0
  p.hp = 0
  p.displayHp = 0
  p.value = value
  p.charge = 0
  p.flash = 0
  p.pending = 0
  p.touched = false
  p.resolved = false
  p.reward = null
  p.gate = null
  p.gatedBy = null
  p.beatT = w.runTime
  p.killedByPlayer = false
  return p
}

/** Smoothed number for the printed readout, so digits glide rather than strobe. */
export function updateDisplayHp(w, dt) {
  const pool = w.props
  for (let i = 0; i < pool.size; i++) {
    const p = pool.items[i]
    p.displayHp = damp(p.displayHp, p.hp, 0.0001, dt * CFG.combat.displayHpLerpHz / 8)
    if (p.flash > 0) p.flash = Math.max(0, p.flash - CFG.fx.hitFlashDecay * dt)
  }
}

/**
 * Resolve anything crossing the squad plane this step.
 *
 * The gap test uses the squad CENTROID plus a FIXED 0.6u radius, never the
 * crowd's real width -- otherwise growing the squad becomes a punishment, which
 * is the bug that makes getting stronger feel worse.
 *
 * AND THE SQUAD KEEPS MOVING AT FULL SCROLL SPEED. A lane runner that stops
 * reads as a physics bug.
 */
export function resolveCrossings(w) {
  const pool = w.props
  const zPlane = CFG.world.squadZ
  for (let i = 0; i < pool.size; i++) {
    const p = pool.items[i]
    if (p.resolved || p.dead || p.z < zPlane) continue
    p.resolved = true

    if (p.kind === 'gate') {
      // Strict containment, no dodge radius: see spawnGate.
      if (Math.abs(p.x - w.anchorX) <= p.halfW) {
        const v = p.value
        if (v >= 0) {
          w.stats.gatesTaken++
          // Paid as joiners, not as a silent counter bump, so a +6 reads as six
          // bodies running in rather than a number changing.
          spawnJoiners(w, p.x, CFG.bubble.y, p.z, v, CFG.gate.joinerStagger)
        } else {
          w.stats.gatesEaten++
          // Already capped at spawn, so this is only the last-ditch guarantee for
          // the case where the squad SHRANK during the approach: never take the
          // final soldier. It resolves in the player's favour, which is the right
          // direction for a number they were shown two seconds ago.
          queueRemove(w, Math.max(1, Math.min(-v, w.count - 1)), CAUSE.BREACH)
        }
        bus.emit(T.GATE_PASS, p.x, CFG.gate.height * 0.5, p.z, v)
      } else {
        bus.emit(T.GATE_MISS, p.x, CFG.gate.height * 0.5, p.z, p.value)
      }
      p.dead = true
      continue
    }

    if (p.kind === 'bubble') {
      // A miss is FREE, always. Punishing a miss teaches players to avoid the
      // most interesting decision in the game.
      w.stats.bubblesMissed++
      bus.emit(T.BUBBLE_MISS, p.x, CFG.bubble.y, p.z)
      p.dead = true
      continue
    }

    const overlap = Math.abs(p.x - w.anchorX) <= p.halfW + CFG.barrel.dodgeTestRadius
    if (!overlap) {
      bus.emit(T.BARREL_DODGED, p.x, 0, p.z, 0, 0, 0, roleId(p.role))
      p.dead = true
      continue
    }

    const lost = breachLoss(w.count, p.role, p.hp, p.maxHp)
    if (lost > 0) queueRemove(w, lost, CAUSE.BREACH)
    w.stats.barrelsBreached++
    bus.emit(T.BARREL_BREACH, p.x, 0, p.z, lost, p.hp / Math.max(1, p.maxHp), 0, roleId(p.role))
    p.dead = true
  }
}

/**
 * Pay out every bubble the player broke this step.
 *
 * This is sim -> sim causality, so it is a direct call and never goes through
 * the bus: the payout must land before roster.commit in the SAME step, or the
 * reward is a frame late and the next beat is priced against the wrong squad.
 */
export function resolveBreaks(w) {
  const pool = w.props
  for (let i = 0; i < pool.size; i++) {
    const p = pool.items[i]
    if (!p.dead || p.resolved || p.kind !== 'bubble' || !p.killedByPlayer) continue
    p.resolved = true
    const r = p.reward
    if (!r) continue
    w.stats.bubblesTaken++
    if (r.type === 'drone') {
      const n = r.count || 1
      for (let k = 0; k < n; k++) spawnDrone(w)
      w.stats.dronesTaken++
      continue
    }
    if (r.type === 'weapon' && upgradeWeapon(w)) continue
    // At max tier a weapon bubble falls back to bodies rather than being wasted.
    const k = soldiersPerBubble(w.runTime) * (r.mult || 1)
    spawnJoiners(w, p.x, CFG.bubble.y, p.z, k)
  }
}
