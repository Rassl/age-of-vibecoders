/**
 * The economy, as pure functions over CFG. No state, no side effects, no three.js.
 *
 * tools/harness.mjs imports THIS FILE, so the balance tables and the shipped game
 * are provably the same code.
 */
import { CFG } from './config.js'
import { clamp, lerp, smoothstep } from './util/math.js'
import { ENEMIES } from './data/enemies.js'
import { WEAPONS } from './data/weapons.js'

// ---------------------------------------------------------------- world motion

/** Corridor scroll speed ramps linearly across the run: difficulty by reaction time. */
export function scrollSpeed(t) {
  const w = CFG.world
  return lerp(w.scrollStart, w.scrollEnd, clamp(t / w.runSeconds, 0, 1))
}

/** Integral of scrollSpeed -- how far the squad has travelled by time t. */
export function distanceAtTime(t) {
  const w = CFG.world
  const T = w.runSeconds
  if (t <= T) return w.scrollStart * t + ((w.scrollEnd - w.scrollStart) / (2 * T)) * t * t
  return distanceAtTime(T) + w.scrollEnd * (t - T)
}

/** Seconds of fire available on something spawned at the horizon. THE budget. */
export function windowSeconds(t) {
  return CFG.world.spawnHorizon / scrollSpeed(t)
}

// -------------------------------------------------------------------- par run

/** The 50th-percentile squad trajectory. Everything is priced as a multiple of this. */
export function parSquad(t) {
  const c = CFG.curves
  return Math.min(c.parSquadBase + c.parSquadRate * t, CFG.squad.maxCount)
}

/** The 50th-percentile weapon multiplier: two tier-ups across a run. */
export function parWeapon(t) {
  const c = CFG.curves
  return c.parWeaponBase * Math.pow(1.5, t / c.parWeaponDouble)
}

export function parDPS(t) {
  return CFG.weapons.baseDps * parSquad(t) * parWeapon(t)
}

/** Actual squad DPS. Strictly linear in count -- every soldier's timer does real damage. */
export function squadDPS(count, tier) {
  const w = WEAPONS[clamp(tier, 0, WEAPONS.length - 1)]
  return CFG.weapons.baseDps * count * w.dpsMult
}

// -------------------------------------------------------------------- barrels

/**
 * Barrel HP.
 *
 * Priced against NOMINAL squad DPS but killed at EFFECTIVE DPS (the player must
 * actually hold the lane) -- that gap is what makes aim the load-bearing skill.
 *
 * The blend toward the player's real DPS is ASYMMETRIC by role: mandatory content
 * (wall) follows you hard so nobody is walled out; optional content (toll) stays
 * pinned to par so the greedy lane is simply closed to a weak squad.
 */
export function barrelHP(role, t, nominalDPS, hpScale = 1) {
  const b = CFG.barrel
  const par = parDPS(t)
  const r = par > 0 ? nominalDPS / par : 1
  const scale = r < 1
    ? 1 - b.lambdaDown[role] * (1 - r)
    : 1 + b.lambdaUp[role] * (r - 1)
  const clamped = clamp(scale, b.scaleClamp[0], b.scaleClamp[1])
  // NG+ prices obstacles up but leaves the reward bubble alone: harder rounds
  // must squeeze the budget, not quietly confiscate the rewards.
  const D = role === 'bubble' ? 1 : CFG.difficulty
  const hp = b.alpha[role] * windowSeconds(t) * par * clamped * hpScale * D
  return roundHp(hp)
}

export function bubbleHP(t, nominalDPS, hpScale = 1) {
  return barrelHP('bubble', t, nominalDPS, hpScale)
}

/** Round to a readable figure: 2s under 100, 5s under 1000, 25s above. */
function roundHp(hp) {
  if (hp < 100) return Math.max(2, Math.round(hp / 2) * 2)
  if (hp < 1000) return Math.round(hp / 5) * 5
  return Math.round(hp / 25) * 25
}

/**
 * Soldiers lost when a barrel reaches the squad plane still alive.
 * The 1.5 exponent makes a near-kill nearly free and ignoring one brutal --
 * that gradient is what teaches commitment.
 */
export function breachLoss(n, role, hpRem, hpMax) {
  const b = CFG.barrel
  if (hpRem <= 0) return 0
  const frac = clamp(hpRem / hpMax, 0, 1)
  const raw = Math.ceil(n * b.breachF[role] * Math.pow(frac, b.breachExp))
  // ceil(0.6n) equals n at n=2, so the documented "no single event wipes a squad
  // of >= 2" guarantee needs the explicit n-1 floor, not just the fraction.
  const cap = Math.max(1, Math.min(n - 1, Math.ceil(n * b.breachCapFrac)))
  return clamp(raw, 1, Math.max(1, cap))
}

/**
 * Soldiers a negative gate actually removes.
 *
 * Authored gate values are absolute (the reference prints -40), but this squad
 * caps at 40 and starts at 3, so an absolute value has to be capped against the
 * live count or an early row is a coin-flip wipe. Same shape as breachLoss.
 */
export function gateLoss(n, value) {
  const raw = Math.max(1, -value)
  const cap = Math.max(1, Math.min(n - 1, Math.ceil(n * CFG.gate.lossCapFrac)))
  return clamp(raw, 1, Math.max(1, cap))
}

// -------------------------------------------------------------------- bubbles

export function soldiersPerBubble(t) {
  const b = CFG.bubble
  return clamp(Math.round(b.perBubbleBase + b.perBubbleRate * t), 2, b.perBubbleMax)
}

// -------------------------------------------------------------------- zombies

export function zombieHP(t, kind) {
  const z = CFG.zombie
  const base = z.walkerHpBase * Math.pow(1.5, t / z.hpDouble)
  // hpMult comes from data/enemies.js, the same table spawnZombie reads for
  // speed/radius/kills. Two tables holding the same numbers is how a new enemy
  // ends up with one file's stats and another file's health.
  return Math.max(1, Math.round(base * ENEMIES[kind].hpMult))
}

/**
 * Threat coefficient: the fraction of par DPS the horde is meant to consume.
 * Above 1.0 the crowd cannot be out-damaged and must be out-manoeuvred.
 */
export function threatBeta(t) {
  const th = CFG.threat
  // NG+ scales the WHOLE pressure curve, lull included: the lull survives as a
  // breather because it is relative to the surrounding waves, not absolute.
  const D = CFG.difficulty
  if (t >= th.lullFrom && t < CFG.world.runSeconds) {
    // The lull exists so the player can read their build before it is tested.
    return th.lullBeta * D
  }
  let beta = th.betaBase + th.betaRate * t
  for (const [centre, amp] of th.waves) beta += amp * waveEnvelope(t, centre)
  const c = th.crescendo
  if (t >= c.from && t < c.to) {
    const k = smoothstep(clamp((t - c.from) / Math.max(0.001, c.to - c.from - 1), 0, 1))
    beta = Math.max(beta, lerp(beta, c.peakBeta, k))
  }
  return beta * D
}

function waveEnvelope(t, centre) {
  const th = CFG.threat
  const half = th.waveHold / 2
  const d = t - centre
  if (d < -half - th.waveRise || d > half + th.waveFall) return 0
  if (d < -half) return (d + half + th.waveRise) / th.waveRise
  if (d <= half) return 1
  return 1 - (d - half) / th.waveFall
}

/** Zombie bodies per second the director should be spawning at time t. */
export function spawnRate(t, nominalDPS) {
  const hp = zombieHP(t, 'walker')
  const demand = (threatBeta(t) * Math.max(nominalDPS, 1)) / hp
  return Math.min(demand, CFG.threat.spawnCap)
}

// ----------------------------------------------------------------------- boss

/**
 * The 0.45 blend compresses an 11x build spread into a ~2.5x outcome spread:
 * never trivial for a great run, never a 45-second slog for a bad one.
 */
export function bossHP(nominalDPS) {
  const b = CFG.boss
  const D = CFG.difficulty
  const raw = b.hpTau * (b.hpPar * parDPS(CFG.world.runSeconds) + b.hpActual * nominalDPS)
  // The ceiling scales with NG+ too, or every round past the first would clamp
  // to the same boss and the loop would stop escalating exactly at the finale.
  return Math.round(clamp(raw * D, b.hpMin, b.hpMax * D))
}

// ------------------------------------------------------------------ formation

/** Slot spacing shrinks mildly with crowd size so 40 soldiers are not a football field. */
export function formationSpacing(n) {
  const f = CFG.formation
  return f.spacingBase * clamp(Math.pow(f.densityRef / Math.max(1, n), f.densityExp), f.densityMin, 1)
}

/**
 * Phyllotaxis slot: a PURE FUNCTION OF INDEX, so gaining soldier N never moves
 * soldiers 0..N-1. Writes into out = {x, z}.
 */
export function formationSlot(i, n, out) {
  const f = CFG.formation
  const spacing = formationSpacing(n)
  const r = Math.min(spacing * Math.sqrt(i), f.maxRadius)
  const a = i * f.phi
  out.x = Math.cos(a) * r * f.squashX
  out.z = Math.sin(a) * r * f.squashZ
  return out
}

/**
 * Crowd extents. X and Z differ by design: squashX keeps the squad NARROW across
 * the corridor (lane commitment stays meaningful at 40 soldiers) while squashZ
 * lets it run long front-to-back. Shockwave sweeps test against the WIDE squad.
 */
export function formationRadiusX(n) {
  const f = CFG.formation
  return Math.min(formationSpacing(n) * Math.sqrt(Math.max(0, n - 1)), f.maxRadius) * f.squashX
}

export function formationRadiusZ(n) {
  const f = CFG.formation
  return Math.min(formationSpacing(n) * Math.sqrt(Math.max(0, n - 1)), f.maxRadius) * f.squashZ
}
