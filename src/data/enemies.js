/**
 * Enemy kinds. Adding one is a row here plus a rig in view/geometry.js.
 *
 * `blocks` is the third axis of the allocation game: a crowd standing in front
 * of a barrel is a DPS shield. `ranged` and `explodes` are the two kinds that
 * are not just a differently-shaped body -- they change what the player has to
 * do, which is the point of having five of them.
 */
export const ENEMIES = {
  walker: {
    id: 'walker', hpMult: 1.0, speed: 5.0, kills: 1, radius: 0.30,
    blocks: true, fromTime: 0, scale: 1.0, cadence: 2.0, pitch: 0.38,
    showHpBar: false, ringRadius: 0.36, weight: 1.0,
  },
  runner: {
    id: 'runner', hpMult: 0.55, speed: 11.0, kills: 1, radius: 0.26,
    blocks: true, fromTime: 25, scale: 0.92, cadence: 3.4, pitch: 0.50,
    showHpBar: false, ringRadius: 0.30, weight: 0.45,
  },
  bloater: {
    // Kills two on contact, but the real reason to shoot it early is that its
    // death blast chews through whatever crowd it is standing in.
    id: 'bloater', hpMult: 3.2, speed: 3.2, kills: 2, radius: 0.45,
    blocks: true, fromTime: 30, scale: 1.2, cadence: 1.5, pitch: 0.22,
    showHpBar: false, ringRadius: 0.46, weight: 0.22,
    explodes: true, blastRadius: 3.2, blastFrac: 0.55,
  },
  spitter: {
    // The only enemy that threatens you WITHOUT reaching you, so it cannot be
    // answered by dodging alone -- it has to be killed, which competes for the
    // same DPS the barrels want.
    id: 'spitter', hpMult: 1.6, speed: 4.0, kills: 1, radius: 0.28,
    blocks: true, fromTime: 40, scale: 0.98, cadence: 1.8, pitch: 0.30,
    showHpBar: false, ringRadius: 0.34, weight: 0.28,
    ranged: true, holdZ: -20, windup: 0.9, reload: 2.4,
  },
  brute: {
    id: 'brute', hpMult: 8.0, speed: 3.5, kills: 3, radius: 0.55,
    blocks: true, fromTime: 55, scale: 1.45, cadence: 1.2, pitch: 0.30,
    showHpBar: true, ringRadius: 0.52, weight: 0.14,
  },
}

export const ENEMY_ORDER = ['walker', 'runner', 'bloater', 'spitter', 'brute']

/** Pick a kind for time t, weighted, respecting each kind's unlock time. */
export function rollEnemyKind(t, rng) {
  let total = 0
  for (const id of ENEMY_ORDER) {
    const e = ENEMIES[id]
    if (t >= e.fromTime) total += e.weight
  }
  let r = rng.next() * total
  for (const id of ENEMY_ORDER) {
    const e = ENEMIES[id]
    if (t < e.fromTime) continue
    r -= e.weight
    if (r <= 0) return id
  }
  return 'walker'
}
