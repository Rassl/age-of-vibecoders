/**
 * Wings: the energy-can pickup.
 *
 * Breaking the bubble lifts the WHOLE squad for CFG.wings.duration seconds. It
 * is a squad-wide scalar rather than per-soldier state on purpose: the roster
 * spawns and swap-removes bodies every step, and a per-body timer would hand a
 * fresh joiner ground-level vulnerability inside an airborne formation.
 *
 * While airborne the squad is out of reach of everything that lives on the
 * road -- contact (collision.js), acid (zombies.js) and shockwaves -- but it
 * keeps shooting and it still pays barrels and gate rows. The pickup answers
 * the horde; it is not a coupon for the economy.
 *
 * `altitude` is the smoothed 0..1 lift, integrated HERE so that the view, the
 * muzzle flashes and the tracers all agree on how high the squad is on any
 * given frame. A view-side smoothing would leave the tracers popping up a
 * third of a second before the bodies.
 */
import { CFG } from '../config.js'
import { bus, T } from '../core/bus.js'

export function grantWings(w) {
  const d = CFG.wings.duration
  // Refresh, never stack: a second can inside one flight tops the timer back up.
  w.wings = d
  w.stats.wingsTaken++
  bus.emit(T.WINGS_ON, w.anchorX, 1.2, CFG.world.squadZ, d)
}

export function updateWings(w, dt) {
  if (w.wings > 0) {
    w.wings -= dt
    if (w.wings <= 0) {
      w.wings = 0
      bus.emit(T.WINGS_OFF, w.anchorX, CFG.wings.height, CFG.world.squadZ)
    }
  }
  const target = w.wings > 0 ? 1 : 0
  w.altitude += (target - w.altitude) * (1 - Math.exp(-dt / CFG.wings.riseTau))
  if (w.altitude < 0.001 && target === 0) w.altitude = 0
}

/** World-space lift of the airborne squad this step, in units. */
export function squadLift(w) {
  return w.altitude * CFG.wings.height
}
