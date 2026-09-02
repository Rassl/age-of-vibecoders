/**
 * The reference bot, shared by harness.mjs and sweep.mjs so the two can never
 * drift apart and report different balance for the same build.
 *
 * Its one parameter is AIM EFFICIENCY, which is the load-bearing skill: bullets
 * go straight and you aim with your body, so a player who cannot hold a lane
 * delivers only a fraction of nominal DPS. Low aim means both late decisions
 * (longer re-decide cooldown) and sloppy tracking (slower, noisier).
 *
 * The lane policy itself lives in src/sim/autopilot.js, because TURRET mode
 * runs it IN THE GAME to drive the squad while the player aims the gun. It is
 * re-exported here unchanged so the harness plays the squad the player gets.
 */
import { CFG } from '../src/config.js'
import { Rng } from '../src/util/rng.js'
import { pickLane } from '../src/sim/autopilot.js'

export { pickLane }

export function makeBot(aim, seed) {
  const rng = new Rng(seed)
  const gateMemo = { rowId: -1, x: 0 }
  let cooldown = 0
  let target = 0
  return {
    decide(w, dt) {
      cooldown -= dt
      if (cooldown <= 0) {
        // Re-decide at a near-constant cadence. Letting aim drive the SWITCHING
        // RATE inverts the whole model: a fast-switching bot thrashes between
        // lanes and sustains DPS on none of them, so "expert" scored worse than
        // "clumsy". Aim governs only how well a chosen lane is HELD.
        cooldown = 0.18 + (1 - aim) * 0.12
        const next = pickLane(w, aim, rng, gateMemo)
        // Hysteresis: ignore micro-corrections, which are the same thrash in
        // miniature, and commit to a lane worth committing to.
        if (Math.abs(next - target) > 0.9) target = next
      }
      // Expressed against cruiseSpeed, and deliberately spanning it: a top-aim
      // bot asks for more than the squad can deliver and is capped by the sim,
      // a clumsy one is slower than the cap. Collapse the spread below the cap
      // and every bot steers identically, which is what erases the aim gradient
      // the balance tables are read from.
      const speed = CFG.input.cruiseSpeed * (0.34 + 0.70 * aim)
      const d = target - w.anchorX
      return Math.max(-speed * dt, Math.min(speed * dt, d))
    },
  }
}
