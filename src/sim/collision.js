/**
 * Contact damage.
 *
 * Runs AFTER combat, deliberately: a zombie the squad killed this step must not
 * also eat a soldier. That ordering IS the fairness contract -- "if I shot it in
 * time, it does not touch me" is the generous read and the one players expect.
 * Reversing it makes every near-miss feel like the game cheating.
 *
 * A scalar |z - squadZ| < band reject discards ~95% of the horde before any real
 * test, because the squad occupies only a ~2u z band. That is the entire
 * broadphase, and it is enough.
 */
import { CFG } from '../config.js'
import { bus, T } from '../core/bus.js'
import { queueRemove, pendingCount, CAUSE } from './roster.js'
import { formationRadiusZ, formationRadiusX } from '../curves.js'

const BAND = 2.5

export function collide(w, dt) {
  const soldiers = w.soldiers
  const zs = w.zombies
  const squadZ = CFG.world.squadZ
  const sr = CFG.squad.soldierRadius

  for (let i = 0; i < soldiers.size; i++) {
    const s = soldiers.items[i]
    if (s.iframe > 0) s.iframe -= dt
  }

  // Airborne (wings pickup): the crowd walks under the squad and past it. The
  // zombies are NOT killed -- flying over a body is not the same as shooting
  // it, and they despawn behind the squad like any body that was dodged.
  if (w.wings > 0) return

  for (let zi = 0; zi < zs.size; zi++) {
    const z = zs.items[zi]
    if (z.dead) continue
    if (Math.abs(z.z - squadZ) > BAND) continue   // the whole broadphase

    const reach = sr + z.radius
    const reach2 = reach * reach
    for (let si = 0; si < soldiers.size; si++) {
      const s = soldiers.items[si]
      if (s.iframe > 0) continue
      const dx = s.x - z.x
      const dz = s.z - z.z
      if (dx * dx + dz * dz > reach2) continue

      // The i-frame bounds how OFTEN contact happens, never how much one
      // contact costs -- so a brute's kills:3 would wipe a squad of 3 in a
      // single frame, which the roster's fail contract says cannot happen.
      const room = Math.max(1, pendingCount(w) - 1)
      queueRemove(w, Math.min(z.kills, room), CAUSE.ZOMBIE)
      // Squad-wide i-frames: caps bleed at ~1.8 soldiers/s so no single clump
      // deletes a squad in one frame.
      for (let k = 0; k < soldiers.size; k++) soldiers.items[k].iframe = CFG.squad.iframeSeconds
      z.dead = true
      bus.emit(T.HIT, z.x, 0.9, z.z, 0, 0, 0, 0)
      break
    }
  }
}

/**
 * Boss shockwaves. Tested against the squad CENTROID plus the current formation
 * radius -- the WIDE squad, deliberately, so a strong player still has to thread
 * them. Per-soldier clipping would cost a random unreadable number of soldiers.
 */
export function collideShockwaves(w, dt) {
  const pool = w.shockwaves
  const squadZ = CFG.world.squadZ
  const rx = formationRadiusX(w.count)
  const rz = formationRadiusZ(w.count)

  for (let i = 0; i < pool.size; i++) {
    const sw = pool.items[i]
    if (sw.dead || sw.hit) continue
    if (Math.abs(sw.z - squadZ) > rz + 0.5) continue
    // The gap is the only safe lane; being inside it is a clean dodge. An
    // airborne squad is over the wave entirely.
    const inGap = Math.abs(w.anchorX - sw.gapX) + rx < sw.gapW * 0.5
    sw.hit = true
    if (inGap || w.wings > 0) continue
    queueRemove(w, CFG.boss.shockKills, CAUSE.SHOCKWAVE)
    bus.emit(T.HIT, w.anchorX, 0.6, squadZ, 0, 0, 0, 0)
  }
}
