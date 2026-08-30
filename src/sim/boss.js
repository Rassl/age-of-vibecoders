/**
 * The boss is the run's SCORE READOUT, not its difficulty peak -- the crescendo
 * is where the build is actually judged. If the boss were also brutal the player
 * would get two failure signals and not know which to fix.
 *
 * Slams are the ENTIRE damage model, so what kills you is always visible and
 * dodgeable: no abstract drain, no fail timer.
 */
import { CFG } from '../config.js'
import { bossHP } from '../curves.js'
import { bus, T } from '../core/bus.js'
import { queueRemove, CAUSE } from './roster.js'
import { spawnZombie } from './zombies.js'
import { STATE } from './world.js'

export function triggerBoss(w) {
  const b = w.boss
  if (b.active) return
  b.active = true
  b.dead = false
  b.gen++
  b.x = 0
  b.z = CFG.boss.spawnZ
  b.maxHp = bossHP(w.nominalDPS)
  b.hp = b.maxHp
  b.plateIndex = 0
  b.stagger = 0
  b.slamTimer = CFG.boss.slamPeriod
  b.addTimer = CFG.boss.addPeriod
  b.rage = CFG.boss.rageTimer
  b.raging = false
  b.phase = 0
  b.flash = 0
  b.contactTimer = 0
  b.entryT = 0
  b.pending = 0
  b.touched = false
  b.kind = 'boss'
  w.state = STATE.BOSS
  w.scrollTarget = 0
  bus.emit(T.BOSS_SPAWN, 0, 0, b.z, b.maxHp)
}

export function updateBoss(w, dt) {
  const b = w.boss
  if (!b.active || b.dead) return
  const C = CFG.boss

  b.entryT += dt
  // Walk into position, then hold. The world decelerates to a stop under it.
  if (b.z < C.standZ) b.z = Math.min(C.standZ, b.z + 6 * dt)

  const prevPhase = b.phase
  b.phase += (b.raging ? 0.9 : 0.55) * dt
  if (Math.floor(prevPhase * 2) !== Math.floor(b.phase * 2)) {
    // Every footfall shakes the world -- reacting to its FEET, not just to its
    // damage, is what makes it heavy.
    bus.emit(T.BOSS_FOOTFALL, b.x, 0, b.z)
  }

  if (b.flash > 0) b.flash = Math.max(0, b.flash - CFG.fx.hitFlashDecay * dt)

  if (b.stagger > 0) {
    b.stagger -= dt
    return
  }

  // Armour plates: each break buys the player a 1.2s stagger.
  const frac = b.hp / b.maxHp
  while (b.plateIndex < C.plates.length && frac <= C.plates[b.plateIndex]) {
    if (b.plateIndex > 0 || frac < 1) {
      b.stagger = C.plateStagger
      bus.emit(T.BOSS_PLATE, b.x, 2.5, b.z, b.plateIndex)
    }
    b.plateIndex++
  }

  // Rage halves both cadences: dangerous, never an instant loss.
  if (!b.raging) {
    b.rage -= dt
    if (b.rage <= 0) {
      b.raging = true
      bus.emit(T.BOSS_RAGE, b.x, 3, b.z)
    }
  }

  const slamPeriod = b.raging ? C.ragePeriod : C.slamPeriod
  b.slamTimer -= dt
  if (b.slamTimer <= 0) {
    b.slamTimer += slamPeriod
    slam(w)
  }

  const addPeriod = b.raging ? C.addPeriod * 0.6 : C.addPeriod
  b.addTimer -= dt
  if (b.addTimer <= 0) {
    b.addTimer += addPeriod
    for (let i = 0; i < 2; i++) {
      spawnZombie(w, 'runner', b.x + (w.rng.next() - 0.5) * 6, b.z + 2 + i)
    }
  }

  // NO contact damage. The boss halts at standZ and the world stops under it, so
  // it never reaches the squad plane -- slams are deliberately the ENTIRE damage
  // model, which is what keeps everything that can kill you visible and
  // dodgeable. (A contact test here was unreachable dead code.)
}

function slam(w) {
  const b = w.boss
  const sw = w.shockwaves.acquire()
  if (!sw) return
  sw.dead = false
  sw.hit = false
  sw.z = b.z + 1
  // The gap moves every slam so the dodge is a read, not a memorised lane.
  sw.gapX = (w.rng.next() - 0.5) * (CFG.world.corridorWidth - CFG.boss.shockGap - 1)
  sw.gapW = CFG.boss.shockGap
  sw.life = 0
  bus.emit(T.BOSS_SLAM, b.x, 0, b.z, sw.gapX, sw.gapW)
}

export function moveShockwaves(w, dt) {
  const pool = w.shockwaves
  for (let i = 0; i < pool.size; i++) {
    const sw = pool.items[i]
    if (sw.dead) continue
    sw.z += CFG.boss.shockSpeed * dt
    sw.life += dt
    if (sw.z > CFG.world.despawnZ) sw.dead = true
  }
}

export function checkBossDeath(w) {
  const b = w.boss
  if (b.active && b.dead && w.state === STATE.BOSS) {
    w.state = STATE.WON
    bus.emit(T.RUN_OVER, 0, 0, 0, 1)
  }
}
