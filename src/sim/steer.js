/**
 * Steering. Runs BEFORE everything else in the substep: the mode's whole promise
 * is that damage starts landing in the lane you just dragged into ON THIS FRAME.
 * Any system computing a muzzle origin or an overlap before the squad has moved
 * is using last frame's position -- that is the "mud" failure, and it is an
 * ordering bug, not a tuning value.
 *
 * VELOCITY MODEL, NOT A POSITION SPRING.
 *
 * The anchor used to chase a target position exponentially. An exponential chase
 * is fastest when it is far from the target and slowest when it is close, so a
 * press produced a lurch that decayed to a crawl -- measured at 11.9 u/s within
 * 150ms, then under 2.4 u/s while still travelling. That is the opposite of
 * linear, and it is what reads as "it goes directly to the side" rather than as
 * the squad moving there.
 *
 * So: input picks a DESIRED VELOCITY, the anchor accelerates toward it at a
 * bounded rate, and it cruises at a flat `cruiseSpeed` for the whole middle of
 * any long move. The flat part is the part the player feels as travel. Position
 * is the integral of that and nothing else writes it.
 *
 * Smooth the RENDER, never the INPUT. The low-pass here exists only to kill
 * touch-digitizer jitter; all the visible slosh comes from per-soldier springs in
 * the view layer.
 */
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'

/**
 * @param {number} dx    drag displacement for this substep, in world units
 * @param {number} axis  discrete steering direction, -1 | 0 | +1 (keys, buttons)
 */
export function steer(w, dt, dx, axis = 0) {
  const c = CFG.world.clampX
  const I = CFG.input

  w.targetXRaw = clamp(w.targetXRaw + dx, -c, c)

  // Low-pass, expressed as an exponential-exact time constant so it is identical
  // at any substep rate.
  const k = 1 - Math.exp(-dt / Math.max(1e-4, I.lowPassTau))
  w.targetXSmooth += (w.targetXRaw - w.targetXSmooth) * k

  // A real drag always takes control back from the keys, mid-release ramp or not.
  if (dx !== 0) w.keySteer = false

  let want
  if (axis !== 0) {
    // A direction, not a destination: hold the key, cruise at a constant speed.
    want = axis * I.cruiseSpeed
    w.keySteer = true
    // Keep the pointer's target glued to where we actually are. Without this the
    // stale drag target is still sitting where the pointer left it, and the first
    // touch after keyboard steering snaps the squad back to it.
    w.targetXRaw = clamp(w.anchorX, -c, c)
    w.targetXSmooth = w.targetXRaw
  } else if (w.keySteer) {
    // Release ramp. Coast to a stop under `decel` and KEEP the pointer target
    // pinned to the anchor on the way down. Handing straight back to the
    // position controller instead makes it read the distance the anchor covers
    // while decelerating as overshoot and drag the squad backwards -- measured
    // as a 0.33u bounce back after every key tap.
    want = 0
    if (Math.abs(w.anchorVelX) < 0.05) w.keySteer = false
    w.targetXRaw = clamp(w.anchorX, -c, c)
    w.targetXSmooth = w.targetXRaw
  } else {
    // Direct manipulation: close the gap to the finger, but never faster than
    // cruise. `arriveTime` is the width of the proportional band at the end of
    // the move -- outside it the move is flat-out, inside it eases in to land
    // without buzzing around the target.
    const err = clamp(w.targetXSmooth, -c, c) - w.anchorX
    want = clamp(err / Math.max(1e-4, I.arriveTime), -I.cruiseSpeed, I.cruiseSpeed)
  }

  // Accelerate toward the desired velocity. THIS is what bounds onset, so no
  // input -- a held key, a violent flick, a frame that arrives late -- can turn
  // into instantaneous displacement. Stopping and reversing use the harsher
  // rate: a squad that keeps coasting after you let go feels like it is on ice.
  const reversing = want * w.anchorVelX < 0
  const rate = (want === 0 || reversing ? I.decel : I.accel) * dt
  w.anchorVelX += clamp(want - w.anchorVelX, -rate, rate)

  let next = w.anchorX + w.anchorVelX * dt
  // Kill the velocity at the rail rather than letting it wind up, so turning
  // away from a wall you are pinned against is immediate.
  if (next > c) { next = c; if (w.anchorVelX > 0) w.anchorVelX = 0 }
  else if (next < -c) { next = -c; if (w.anchorVelX < 0) w.anchorVelX = 0 }
  w.anchorX = next
}

/**
 * TURRET mode: the same drag, pointed at the gun instead of the squad.
 *
 * The reticle is a point on the CFG.turret.aimZ plane. The drag arrives in
 * corridor units at the squad plane (Input converts pixels once, for both
 * modes), and is rescaled here so the finger travel that crosses the corridor
 * in ADVANCE sweeps the reticle rail to rail at the aim plane in TURRET. The
 * yaw is derived from the smoothed aim and stored on the world, so the ray
 * cast (combat.fireTurret) and the gun mesh (view/turret.js) read ONE angle.
 *
 * Deliberately no velocity model: a gun on a pivot is a direct manipulation,
 * and every millisecond between the finger and the beam reads as sluggish.
 * The low-pass is digitizer jitter only.
 */
export function steerTurret(w, dt, dx, axis = 0) {
  const t = CFG.turret
  const gain = t.aimClampX / CFG.world.clampX
  let raw = w.turretAimRaw + dx * gain + axis * t.aimSpeed * dt
  w.turretAimRaw = clamp(raw, -t.aimClampX, t.aimClampX)
  const k = 1 - Math.exp(-dt / Math.max(1e-4, t.aimTau))
  w.turretAim += (w.turretAimRaw - w.turretAim) * k
  // The truck trails the squad (last substep's anchor: this runs before
  // steer(), and one step of lag is nothing against the vehicle's own).
  const kf = 1 - Math.exp(-dt / Math.max(1e-4, t.followTau))
  w.turretX += (w.anchorX * t.follow - w.turretX) * kf
  // Positive yaw = aiming right (+x). The view negates it for three's
  // right-handed rotation about +Y.
  w.turretYaw = Math.atan2(w.turretAim - w.turretX, t.z - t.aimZ)
}

/** Gameplay soldier positions: effectively instant. Visual lag lives in the view. */
export function resolveSquadPositions(w) {
  const items = w.soldiers.items
  for (let i = 0; i < w.soldiers.size; i++) {
    const s = items[i]
    s.x = w.anchorX + s.slotX
    s.z = CFG.world.squadZ + s.slotZ
  }
}
