/**
 * The self-driving squad, and the lane policy it shares with the harness bot.
 *
 * In TURRET mode the drag belongs to the gun, so somebody else has to decide
 * which lane the squad stands in. That somebody is the SAME policy
 * tools/harness.mjs plays the balance tables with: `pickLane` lives here and
 * tools/bot.mjs re-exports it, so the squad the player watches in a turret
 * round is provably the squad the balance numbers were measured against.
 * Two copies of a lane valuation would drift inside a week.
 *
 * Its one parameter is AIM EFFICIENCY (CFG.turret.squadAim), the load-bearing
 * skill of the mode: bullets go straight and the squad aims with its body, so
 * a pilot that cannot hold a lane delivers only a fraction of nominal DPS.
 * Low aim means both late decisions (longer re-decide cooldown) and sloppy
 * tracking (slower, noisier).
 *
 * Nothing here imports three.js and nothing subscribes to the bus.
 */
import { CFG } from '../config.js'
import { MAX_TIER } from '../data/weapons.js'
import { clamp } from '../util/math.js'

/**
 * How fast props actually approach the squad plane. In ADVANCE that is the
 * treadmill; in HOLDOUT (w.mode === 1) the road is frozen and props drift in
 * at CFG.holdout.propSpeed -- dividing by w.scroll there reads every barrel as
 * a minute away and the bot ignores it until it is already breaching.
 */
function closingSpeed(w) {
  return w.mode === 1 ? CFG.holdout.propSpeed : Math.max(1, w.scroll)
}

/** Bodies about to reach the squad plane near x. */
function crowdAt(w, x) {
  let n = 0
  for (let i = 0; i < w.zombies.size; i++) {
    const z = w.zombies.items[i]
    if (z.dead || z.z < -16 || z.z > 0.5) continue
    if (Math.abs(z.x - x) < 1.3) n += z.kills
  }
  return n
}

/** Acid already committed to a lane. Standing here costs a soldier. */
function spitDangerAt(w, x) {
  let d = 0
  for (let i = 0; i < w.spits.size; i++) {
    const s = w.spits.items[i]
    if (s.dead) continue
    if (Math.abs(s.x - x) < CFG.zombie.spitRadius + 0.4) d += 1
  }
  return d
}

/** A holding spitter cannot be dodged forever -- it has to be shot. */
function spitterAt(w, x) {
  let n = 0
  for (let i = 0; i < w.zombies.size; i++) {
    const z = w.zombies.items[i]
    if (z.dead || !z.ranged || !z.holding) continue
    if (Math.abs(z.x - x) < 1.0) n++
  }
  return n
}

const GATE_LOOKAHEAD = 2.4

/**
 * Value the lanes: prefer a reachable bubble, then the cheapest live barrel,
 * then the least crowded stretch of road.
 *
 * @param {object} w      world, read-only
 * @param {number} aim    aim efficiency 0..1
 * @param {{next: Function}} rng  any source of uniform [0,1)
 * @param {{rowId: number, x: number}} memo  gate-row commitment, mutated
 * @returns {number} target x for the squad anchor
 */
export function pickLane(w, aim, rng, memo) {
  let best = null
  let bestScore = -Infinity

  for (let i = 0; i < w.props.size; i++) {
    const p = w.props.items[i]
    if (p.dead || p.z > -1) continue
    // Gates carry hp 0, so the generic barrel scoring below rates them a free
    // `3 - 0` and the bot STEERS INTO the -9 segment. They get their own pass.
    if (p.kind === 'gate') continue
    const timeLeft = (0 - p.z) / closingSpeed(w)
    if (timeLeft > 6.5) continue
    const ttk = p.hp / Math.max(1, w.nominalDPS)
    const gate = p.gatedBy && !p.gatedBy.dead ? p.gatedBy.hp / Math.max(1, w.nominalDPS) : 0
    const total = ttk + gate
    if (total > timeLeft * 1.15) continue

    const rw = p.reward
    let score = p.kind === 'bubble'
      ? (rw && rw.type === 'weapon' && w.tier < MAX_TIER ? 22
        // A drone is a timed power spike, so it is worth more than bodies but
        // less than a permanent weapon tier.
        //
        // This preference is only LEGITIMATE because the bubble advertises
        // itself: a drone bubble draws a drone and a 'DRONE' badge. While it
        // still rendered as a soldier trio with a '+N' badge, this line was the
        // bot acting on information no player had, and it made the harness's
        // drone numbers an artifact -- a cost-driven policy took 4 drones in 60
        // runs, because the drone lane costs 2.3x the identical-looking lane
        // beside it. If the bubble ever stops being legible, delete this.
        : rw && rw.type === 'drone' ? 17 : 11) - total
      : p.role === 'wall' ? 16 - total : 3 - total
    if (p.kind === 'bubble' && p.reward && p.reward.mult) score += 3
    score -= Math.abs(p.x - w.anchorX) * 0.15
    score -= crowdAt(w, p.x) * 1.1
    score -= spitDangerAt(w, p.x) * 6.0     // never park in committed acid
    if (score > bestScore) { bestScore = score; best = p }
  }

  const err = (1 - aim) * (rng.next() - 0.5) * 5.0

  // A gate row is unavoidable and immediate, so once it is close enough it
  // outranks every other consideration: being in the wrong segment costs
  // soldiers no amount of DPS can win back inside the window.
  let rowZ = -Infinity
  for (let i = 0; i < w.props.size; i++) {
    const p = w.props.items[i]
    if (p.dead || p.kind !== 'gate' || p.z > -0.5) continue
    if (p.z > rowZ) rowZ = p.z
  }
  if (rowZ > -Infinity && (0 - rowZ) / closingSpeed(w) < GATE_LOOKAHEAD) {
    // Identify the row so the choice is made ONCE and then committed to.
    //
    // Continuous re-sampling was the bug: with a fresh +/-1.7u error every
    // 0.2s the mistakes averaged out long before the row arrived, so every
    // skill tier from 0.95 down to 0.4 took the good segment EVERY time and
    // gatesEaten was 0 across the board. A real player commits early and is
    // then wrong for the whole approach.
    let rowId = Infinity
    let bestSeg = null
    let bestV = -Infinity
    let segs = 0
    for (let i = 0; i < w.props.size; i++) {
      const p = w.props.items[i]
      if (p.dead || p.kind !== 'gate' || Math.abs(p.z - rowZ) > 0.5) continue
      segs++
      if (p.id < rowId) rowId = p.id
      // Bias by distance so a marginally better segment across the corridor
      // does not beat an adequate one already under the squad.
      const v = p.value - Math.abs(p.x - w.anchorX) * 0.25
      if (v > bestV) { bestV = v; bestSeg = p }
    }
    if (bestSeg) {
      if (!memo || memo.rowId !== rowId) {
        let choice = bestSeg
        // Misread the row outright, with a probability that scales with aim.
        if (rng.next() < (1 - aim) * 0.9) {
          let pick = Math.floor(rng.next() * segs)
          for (let i = 0; i < w.props.size; i++) {
            const p = w.props.items[i]
            if (p.dead || p.kind !== 'gate' || Math.abs(p.z - rowZ) > 0.5) continue
            if (pick-- === 0) { choice = p; break }
          }
        }
        if (memo) { memo.rowId = rowId; memo.x = choice.x }
        return clamp(choice.x, -CFG.world.clampX, CFG.world.clampX)
      }
      return clamp(memo.x, -CFG.world.clampX, CFG.world.clampX)
    }
  }

  // A holding spitter outranks a cheap barrel: it is the only threat that
  // cannot be answered by moving, so it must be traded DPS for.
  let sx = null
  let sBest = 0
  for (let x = -CFG.world.clampX; x <= CFG.world.clampX; x += 0.75) {
    const n = spitterAt(w, x)
    if (n > sBest) { sBest = n; sx = x }
  }
  if (sBest > 0 && (!best || bestScore < 6)) {
    return clamp(sx + err, -CFG.world.clampX, CFG.world.clampX)
  }

  if (!best) {
    let bx = w.anchorX
    let bn = Infinity
    for (let x = -CFG.world.clampX; x <= CFG.world.clampX; x += 0.75) {
      const n = crowdAt(w, x) + spitDangerAt(w, x) * 4 + Math.abs(x - w.anchorX) * 0.08
      if (n < bn) { bn = n; bx = x }
    }
    return clamp(bx + err, -CFG.world.clampX, CFG.world.clampX)
  }
  return clamp(best.x + err, -CFG.world.clampX, CFG.world.clampX)
}

/**
 * One substep of the in-sim pilot. Returns the drag displacement (world units,
 * this substep) that steer() should consume -- the exact quantity the harness
 * bot returns, so the squad moves under the same velocity model, rate cap and
 * rail clamp as a finger would drive it. The pilot never writes anchorX.
 *
 * State lives on the world (w.auto) rather than in a closure so a restart
 * rewinds it with everything else and the run stays deterministic per seed.
 */
export function autopilot(w, dt) {
  const t = CFG.turret
  const a = w.auto
  a.cooldown -= dt
  if (a.cooldown <= 0) {
    // Re-decide at a near-constant cadence. Letting aim drive the SWITCHING
    // RATE inverts the whole model: a fast-switching pilot thrashes between
    // lanes and sustains DPS on none of them. Aim governs only how well a
    // chosen lane is HELD.
    a.cooldown = t.squadReact + (1 - t.squadAim) * 0.12
    const next = pickLane(w, t.squadAim, w.rng, a)
    // Hysteresis: ignore micro-corrections, which are the same thrash in
    // miniature, and commit to a lane worth committing to.
    if (Math.abs(next - a.target) > 0.9) a.target = next
  }
  // Expressed against cruiseSpeed, and deliberately spanning it: a top-aim
  // pilot asks for more than the squad can deliver and is capped by the sim,
  // a clumsy one is slower than the cap.
  const speed = CFG.input.cruiseSpeed * (0.34 + 0.70 * t.squadAim)
  const d = a.target - w.anchorX
  return clamp(d, -speed * dt, speed * dt)
}
