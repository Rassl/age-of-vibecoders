/**
 * Firing, hitscan resolution, and the damage ledger.
 *
 * BULLETS GO STRAIGHT AND YOU AIM WITH YOUR BODY. Rays travel along -Z from each
 * soldier's own muzzle with no seeking. The instant you add auto-aim, lane
 * position stops mattering and the entire premise of the mode evaporates.
 *
 * Damage is LEDGERED and applied once per target per step. At 40 shooters
 * converging on one 20hp walker, per-impact application silently burns most of a
 * step's DPS into a corpse and emits the death event forty times.
 */
import { CFG } from '../config.js'
import { WEAPONS } from '../data/weapons.js'
import { bus, T } from '../core/bus.js'
import { BK } from './targets.js'
import { CAUSE } from './roster.js'

/** Tick every soldier's timer and cast this step's rays. */
export function fire(w, dt) {
  if (w.count === 0) return
  const wep = WEAPONS[w.tier]
  const perSoldierDps = CFG.weapons.baseDps * wep.dpsMult
  const shotDamage = perSoldierDps / wep.rate / wep.pellets
  const period = 1 / wep.rate
  const visible = CFG.weapons.visibleShooters
  const items = w.soldiers.items

  for (let i = 0; i < w.soldiers.size; i++) {
    const s = items[i]
    s.fireTimer -= dt
    if (s.fireTimer > 0) continue
    // Accumulate rather than assign so a high fire rate cannot drift slow.
    s.fireTimer += period
    if (s.fireTimer < 0) s.fireTimer = period

    // Underdamped recoil: at 4+ shots/s this never settles, so the whole
    // formation permanently shudders. One float, strongest "we are shooting"
    // signal in the game.
    s.recoilVel += 1.0

    const muzzleX = s.x + 0.20 * s.scale
    const muzzleZ = s.z - 0.52 * s.scale

    for (let p = 0; p < wep.pellets; p++) {
      const spread = wep.pellets > 1
        ? (p - (wep.pellets - 1) / 2) * wep.spreadX
        : (wep.spreadX ? (w.rng.next() - 0.5) * wep.spreadX : 0)
      castRay(w, muzzleX + spread, muzzleZ, shotDamage, wep.pierce)
    }

    if (s.slot < visible) {
      bus.emit(T.MUZZLE, muzzleX, 1.24 * s.scale, muzzleZ, s.slot)
      bus.emit(T.TRACER, muzzleX, 1.24 * s.scale, muzzleZ, w.lastHitZ, s.slot, 0, w.tier)
    }
  }
}

/**
 * Straight ray along -Z. Walks the near-to-far blocker array and takes the first
 * (1 + pierce) blockers whose x-extent contains the ray.
 */
function castRay(w, x, z, damage, pierce) {
  const arr = w.blockers
  const n = w.blockerCount
  let hits = 0
  const maxHits = 1 + pierce
  const bullet = CFG.combat.bulletRadius
  let stopZ = 0
  let stopped = false

  for (let i = 0; i < n; i++) {
    const b = arr[i]
    if (b.z > z) continue                  // behind the muzzle
    if (Math.abs(x - b.x) > b.half + bullet) continue
    queueImpact(w, b.ref, damage, x, b.z)

    if (!stopped) { stopZ = b.z; stopped = true }
    hits++
    // Pierce cuts through BODIES only. Letting it carry on through a barrel or
    // a bubble would let the minigun shoot the reward straight through its own
    // toll, which deletes the pair beat's entire gating mechanic for the back
    // half of the run.
    if (b.kind !== BK.ZOMBIE) break
    if (hits >= maxHits) break
  }

  w.lastHitZ = stopped ? stopZ : -CFG.world.spawnHorizon
}

/**
 * Queue a deferred impact. With impactDelay = 0 this is EXACTLY hitscan and the
 * delay stays a pure tuning knob rather than a structural commitment.
 */
function queueImpact(w, target, damage, x, z) {
  if (CFG.combat.impactDelay <= 0) {
    queueDamage(w, target, damage)
    return
  }
  const im = w.impacts.acquire()
  if (!im) { queueDamage(w, target, damage); return }
  im.target = target
  im.gen = target.gen
  im.damage = damage
  im.due = w.runTime + CFG.combat.impactDelay
  im.x = x; im.y = 1.0; im.z = z
}

/** Pop every impact whose time has come; discard any whose target was recycled. */
export function resolveImpacts(w) {
  const pool = w.impacts
  for (let i = pool.size - 1; i >= 0; i--) {
    const im = pool.items[i]
    if (im.due > w.runTime) continue
    const t = im.target
    if (!t || t.gen !== im.gen || t.dead) {
      w.impactsDiscarded++
    } else {
      queueDamage(w, t, im.damage)
    }
    im.target = null
    pool.release(i)
  }
}

export function queueDamage(w, target, damage) {
  if (!target || target.dead) return
  if (!target.touched) {
    target.touched = true
    w.touched[w.touchedCount++] = target
  }
  target.pending += damage
}

/**
 * Apply the ledger once per target, detect each death exactly once, emit.
 * The most bug-prone point in the simulation, so it gets its own pass.
 */
export function flushDamage(w) {
  for (let i = 0; i < w.touchedCount; i++) {
    const t = w.touched[i]
    w.touched[i] = null
    t.touched = false
    const dmg = t.pending
    t.pending = 0
    if (t.dead || dmg <= 0) continue

    // A gate converts damage into VALUE, never into hp -- it has none, so the
    // ordinary path below would take it straight to <= 0 and kill it on the
    // first bullet.
    if (t.kind === 'gate') {
      t.charge += dmg
      t.flash = 1
      w.stats.damageDealt += dmg
      const step = Math.max(1e-3, w.nominalDPS * CFG.gate.secondsPerStep)
      let ticks = 0
      while (t.charge >= step && t.value < CFG.gate.maxValue) {
        t.charge -= step
        t.value++
        ticks++
      }
      // Do not bank charge against a cap that can never pay out, or a plate held
      // at max quietly stores a run's worth of DPS and dumps it if the cap moves.
      if (t.value >= CFG.gate.maxValue) t.charge = 0
      if (ticks > 0) bus.emit(T.GATE_TICK, t.x, CFG.gate.height * 0.5, t.z, t.value)
      continue
    }

    const applied = Math.min(dmg, t.hp)
    t.hp -= dmg
    t.flash = 1
    w.stats.damageDealt += applied

    if (t.hp > 0) {
      bus.emit(T.HIT, t.x, 1.0, t.z, applied, 0, 0, blockerKindOf(t))
      continue
    }

    t.hp = 0
    t.dead = true
    t.killedByPlayer = true

    if (t === w.boss) {
      w.boss.dead = true
      bus.emit(T.BOSS_DEAD, t.x, 0, t.z)
    } else if (t.kind === 'barrel') {
      w.stats.barrelsKilled++
      bus.emit(T.BARREL_DEAD, t.x, 0, t.z, t.maxHp, 0, 0, roleId(t.role))
    } else if (t.kind === 'bubble') {
      bus.emit(T.BUBBLE_BREAK, t.x, CFG.bubble.y, t.z, 0, 0, 0, 0)
    } else {
      w.stats.kills++
      bus.emit(T.KILL, t.x, 0, t.z, 0, 0, 0, kindId(t.kind))
    }
  }
  w.touchedCount = 0
}

function blockerKindOf(t) {
  if (t.kind === 'gate') return BK.GATE
  if (t.kind === 'barrel') return BK.BARREL
  if (t.kind === 'bubble') return BK.BUBBLE
  if (t.maxHp && t.plateIndex !== undefined) return BK.BOSS
  return BK.ZOMBIE
}

const ROLE_ID = { cheap: 0, wall: 1, toll: 2 }
export function roleId(r) { return ROLE_ID[r] ?? 0 }

const KIND_ID = { walker: 0, runner: 1, brute: 2, spitter: 3, bloater: 4 }
export function kindId(k) { return KIND_ID[k] ?? 0 }

export { CAUSE }
