/**
 * Render interpolation.
 *
 * The simulation advances in fixed 1/60 steps while the display refreshes at
 * whatever rate it likes. Without interpolation a 120Hz panel shows each sim
 * state for two frames, and even at 60Hz the accumulator drifts so some frames
 * advance the world twice and some not at all. At a scroll speed of 14-18
 * units/second that reads as constant judder -- the single biggest reason a
 * fixed-timestep game "isn't smooth" despite a healthy average frame rate.
 *
 * The view layer is read-only over sim state, so rather than teach a dozen view
 * modules about `alpha`, this hands them an INTERPOLATED SNAPSHOT: the true
 * value is stashed, an eased value is written in its place, the frame is drawn,
 * and the true value is restored before the next step reads it. One place to
 * reason about, and no view module can forget to do it.
 */

/** Positions as they were at the START of the last step. */
export function snapshot(w) {
  each(w, (e, hasY) => {
    e.px = e.x
    e.pz = e.z
    if (hasY) e.py = e.y
  })
  w.boss.px = w.boss.x
  w.boss.pz = w.boss.z
  w.prevDistance = w.distance
  w.prevAnchorX = w.anchorX
}

let heldDistance = 0
let heldAnchorX = 0

/** Ease every drawn position back toward its previous value by (1 - alpha). */
export function applyInterpolation(w, alpha) {
  const k = 1 - (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha)
  if (k <= 0.0001) return false
  // A single undefined previous value poisons the camera with NaN permanently,
  // and a NaN camera renders a blank screen with no error anywhere.
  if (!Number.isFinite(w.prevAnchorX) || !Number.isFinite(w.prevDistance)) return false

  each(w, (e, hasY) => {
    if (e.px === undefined) return
    e.cx = e.x
    e.cz = e.z
    e.x -= (e.x - e.px) * k
    e.z -= (e.z - e.pz) * k
    if (hasY) {
      e.cy = e.y
      e.y -= (e.y - e.py) * k
    }
  })

  const b = w.boss
  if (b.px !== undefined) {
    b.cx = b.x; b.cz = b.z
    b.x -= (b.x - b.px) * k
    b.z -= (b.z - b.pz) * k
  }

  // The corridor is a pure function of distance, so easing this one scalar is
  // what stops the road and the railings stuttering.
  heldDistance = w.distance
  heldAnchorX = w.anchorX
  w.distance -= (w.distance - w.prevDistance) * k
  w.anchorX -= (w.anchorX - w.prevAnchorX) * k
  return true
}

/** Put the true simulation values back before the next step reads them. */
export function restoreInterpolation(w, applied) {
  if (!applied) return
  each(w, (e, hasY) => {
    if (e.cx === undefined) return
    e.x = e.cx
    e.z = e.cz
    if (hasY && e.cy !== undefined) e.y = e.cy
  })
  const b = w.boss
  if (b.cx !== undefined) { b.x = b.cx; b.z = b.cz }
  w.distance = heldDistance
  w.anchorX = heldAnchorX
}

/** Visit every entity that moves in world space. */
function each(w, fn) {
  const zs = w.zombies
  for (let i = 0; i < zs.size; i++) fn(zs.items[i], false)
  const ps = w.props
  for (let i = 0; i < ps.size; i++) fn(ps.items[i], false)
  const js = w.joiners
  for (let i = 0; i < js.size; i++) fn(js.items[i], true)
  const ss = w.spits
  for (let i = 0; i < ss.size; i++) fn(ss.items[i], true)
  const sw = w.shockwaves
  for (let i = 0; i < sw.size; i++) fn(sw.items[i], false)
  const dr = w.drones
  for (let i = 0; i < dr.size; i++) fn(dr.items[i], true)
  const bl = w.bolts
  for (let i = 0; i < bl.size; i++) fn(bl.items[i], true)
}
