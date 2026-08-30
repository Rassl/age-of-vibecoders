/**
 * The reference bot, shared by harness.mjs and sweep.mjs so the two can never
 * drift apart and report different balance for the same build.
 *
 * Its one parameter is AIM EFFICIENCY, which is the load-bearing skill: bullets
 * go straight and you aim with your body, so a player who cannot hold a lane
 * delivers only a fraction of nominal DPS. Low aim means both late decisions
 * (longer re-decide cooldown) and sloppy tracking (slower, noisier).
 */
import { CFG } from '../src/config.js'
import { MAX_TIER } from '../src/data/weapons.js'
import { Rng } from '../src/util/rng.js'

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

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

export function pickLane(w, aim, rng, memo) {
  let best = null
  let bestScore = -Infinity

  for (let i = 0; i < w.props.size; i++) {
    const p = w.props.items[i]
    if (p.dead || p.z > -1) continue
    // Gates carry hp 0, so the generic barrel scoring below rates them a free
    // `3 - 0` and the bot STEERS INTO the -9 segment. They get their own pass.
    if (p.kind === 'gate') continue
    const timeLeft = (0 - p.z) / Math.max(1, w.scroll)
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
        // This preference is only LEGITIMATE because the bubble now advertises
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
  if (rowZ > -Infinity && (0 - rowZ) / Math.max(1, w.scroll) < GATE_LOOKAHEAD) {
    // Identify the row so the choice is made ONCE and then committed to.
    //
    // Continuous re-sampling was the bug: with a fresh +/-1.7u error every
    // 0.2s the mistakes averaged out long before the row arrived, so every
    // skill tier from 0.95 down to 0.4 took the good segment EVERY time and
    // gatesEaten was 0 across the board. A real player commits early and is
    // then wrong for the whole approach.
    let rowId = Infinity
    let best = null
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
      if (v > bestV) { bestV = v; best = p }
    }
    if (best) {
      if (!memo || memo.rowId !== rowId) {
        let choice = best
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
