/**
 * The one data structure in the game: a flat, x-extent-tagged blocker array
 * sorted NEAR-TO-FAR, rebuilt after all movement and before any shooting.
 *
 * There is no broadphase and that is the answer the arithmetic gives: hitscan
 * deletes the entire bullet-collision category, and one index serves both the
 * fire pass and the contact pass. Rebuilding it before movement is the classic
 * source of "the ray missed a zombie that was clearly there".
 */
import { CFG } from '../config.js'

export const BK = { ZOMBIE: 1, BARREL: 2, BUBBLE: 3, BOSS: 4, GATE: 5 }

export function rebuildTargets(w) {
  const arr = w.blockers
  let n = 0
  const cap = arr.length

  const zs = w.zombies
  for (let i = 0; i < zs.size && n < cap; i++) {
    const z = zs.items[i]
    if (z.dead || z.z > 0.6) continue
    const b = arr[n++]
    b.ref = z; b.x = z.x; b.z = z.z; b.half = z.radius; b.kind = BK.ZOMBIE
  }

  const ps = w.props
  for (let i = 0; i < ps.size && n < cap; i++) {
    const p = ps.items[i]
    // Gates carry hp 0 by design, so they need an explicit pass: they are
    // targets (shooting one walks its number up) but never obstacles.
    const isGate = p.kind === 'gate'
    if (p.dead || p.z > 0.6 || (!isGate && p.hp <= 0)) continue
    const b = arr[n++]
    b.ref = p; b.x = p.x; b.z = p.z
    b.half = p.kind === 'barrel' || isGate ? p.halfW : CFG.bubble.radius
    b.kind = p.kind === 'barrel' ? BK.BARREL : isGate ? BK.GATE : BK.BUBBLE
  }

  const boss = w.boss
  if (boss.active && !boss.dead && n < cap) {
    const b = arr[n++]
    b.ref = boss; b.x = boss.x; b.z = boss.z; b.half = CFG.boss.radius; b.kind = BK.BOSS
  }

  // Insertion sort by z DESCENDING (nearest to the squad plane first).
  // O(n) in practice: everything scrolls at the same rate, so the array is
  // already nearly sorted and only self-moving zombies perturb it.
  for (let i = 1; i < n; i++) {
    const b = arr[i]
    let j = i - 1
    while (j >= 0 && arr[j].z < b.z) { arr[j + 1] = arr[j]; j-- }
    arr[j + 1] = b
  }

  w.blockerCount = n
}
