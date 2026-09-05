/**
 * Composed set-pieces: the recipes that turn one sim fact into one FELT moment.
 *
 * reactions.js is the one place that decides what a fact looks like -- that does
 * not change. What changed is that a good impact is now six calls across four
 * modules (puff, directional spray, flash, decal, ring, number), and six calls
 * repeated at eight event sites is how the barrel blast and the boss blast
 * silently drift into two different-looking explosions. So the RECIPE lives here,
 * next to the emitters it drives, and reactions.js stays one line per event.
 *
 * Nothing in this file owns a resource, a mesh or a frame callback. It never
 * appears in the render loop -- every module it calls is synced by main.js in
 * its own right. It is pure composition, and deleting it would only mean
 * inlining these bodies back into reactions.js.
 *
 * Every dependency is optional and null-checked. A partially wired build must
 * lose an effect, never throw in the middle of an explosion.
 */
import { CFG } from '../config.js'
import { CHUNK } from './debris.js'

/** Blocker kinds, from sim/targets.js BK. Duplicated because view never imports sim/. */
const BK_ZOMBIE = 1
const BK_BARREL = 2
const BK_BUBBLE = 3
const BK_BOSS = 4

/** Shock-ring tones, from rings.js addShockRing. */
const TONE_FIRE = 0
const TONE_TOXIC = 1
const TONE_CYAN = 2

// Impact flashes are stamped on the tracers' flash mesh, so they cost no draw
// call of their own. Warm white for metal, cold white for glass.
const FLASH_METAL_R = 1.00, FLASH_METAL_G = 0.86, FLASH_METAL_B = 0.55
const FLASH_GLASS_R = 0.70, FLASH_GLASS_G = 0.95, FLASH_GLASS_B = 1.00

/**
 * @param {object} deps every field optional:
 *   { particles, rings, tracers, decals, debris, damage }
 *   `damage` is the createDamageNumbers instance.
 */
export function createBlasts(deps) {
  const particles = deps.particles || null
  const rings = deps.rings || null
  const tracers = deps.tracers || null
  const decals = deps.decals || null
  const debris = deps.debris || null
  const damage = deps.damage || null

  /**
   * A round landing on something that survived it.
   *
   * The whole point is that the four materials answer DIFFERENTLY. Before this,
   * every hit in the game was three generic sparks, so shooting a barrel, a
   * body and a glass bubble produced identical feedback -- which quietly told
   * the player that what they were shooting did not matter.
   *
   * @param {number} kind blocker kind (1 zombie, 2 barrel, 3 bubble, 4 boss)
   * @param {number} amount damage applied, for the floating number
   */
  function impact(x, y, z, kind, amount) {
    if (damage && amount > 0) damage.add(x, y, z, amount, kind)

    if (kind === BK_BARREL || kind === BK_BOSS) {
      // Metal REFUSES the round: fast bright ricochet plus a hard little flash.
      // The flash is what makes it read as a strike rather than as a spray.
      if (particles) {
        particles.burstDir('rico', x, y, z, kind === BK_BOSS ? 7 : 5, 0, 0, 3.5)
        particles.burst('smoke', x, y, z, 1)
      }
      if (tracers) {
        tracers.spawnFlash(
          x, y, z + 0.1, 0.30, 0.30,
          FLASH_METAL_R, FLASH_METAL_G, FLASH_METAL_B, 0.055, 2.2,
        )
      }
      return
    }

    if (kind === BK_BUBBLE) {
      // Glass: motes that twinkle, and a pale cold flash. No spray at all --
      // a bubble is a thing you are opening, not a thing you are wounding.
      if (particles) particles.burst('glint', x, y, z, 5)
      if (tracers) {
        tracers.spawnFlash(
          x, y, z + 0.1, 0.26, 0.26,
          FLASH_GLASS_R, FLASH_GLASS_G, FLASH_GLASS_B, 0.05, 1.6,
        )
      }
      return
    }

    // Flesh: a dark puff that HANGS (low frequency, so the hit registers at
    // distance) plus a tight spray thrown back along the bullet's path toward
    // the camera (high frequency, so it registers as directional).
    if (particles) {
      particles.burst('flesh', x, y, z, 4)
      particles.burstDir('gore', x, y, z, 4, 0, 0, 4.0)
    }
  }

  /** An ordinary zombie death. Deliberately no trauma: if everything shakes, nothing does. */
  function kill(x, z) {
    if (particles) particles.burst('blood', x, 0.9, z, 8)
    // The mark is the point. A corridor the squad has fought down should not
    // look identical to a corridor nothing has happened in.
    if (decals) decals.addBlood(x, z, 0.9)
  }

  /**
   * The bloater. GREEN, and the only saturated green in the scene, so a pop
   * cannot be confused with a barrel (red) or a reward bubble (cyan) -- which
   * matters because the blast is a REWARD for shooting it early and the player
   * has to learn that in one look.
   * @param {number} radius the sim's blastRadius, so the ring matches the hitbox
   */
  function bloater(x, y, z, radius) {
    const r = radius > 0 ? radius : 3.2
    if (particles) {
      particles.burst('toxic', x, y, z, 20)
      particles.burst('bile', x, y, z, 14)
      particles.burst('smoke', x, y + 0.4, z, 6)
    }
    if (debris) debris.burstChunks(x, y, z, 6, 0.85, CHUNK.FLESH)
    // A ring at the ACTUAL blast radius: this is the one explosion in the game
    // whose extent the player needs to read, because it decides how much of the
    // crowd around it just died.
    if (rings) rings.addShockRing(x, z, r * 0.25, r, 0.45, TONE_TOXIC)
    if (decals) decals.addBile(x, z, r * 0.7)
  }

  /**
   * A barrel destroyed by the player. The heaviest routine in the file, and it
   * should be: this is the moment the whole allocation game pays out.
   * @param {number} power roughly 1 for a cheap barrel, up to ~1.6 for a wall
   */
  function barrel(x, z, power) {
    const p = power > 0 ? power : 1
    if (particles) {
      particles.burst('fire', x, 1.0, z, Math.round(16 * p))
      particles.burst('ember', x, 1.0, z, 10)
      particles.burst('spark', x, 1.0, z, 10)
      particles.burst('smoke', x, 1.2, z, 8)
      // The tail. Everything above is gone inside a second; the plume is what
      // makes it read as an event with a decay rather than as a video cut.
      particles.burst('plume', x, 1.4, z, 6)
      particles.burst('dust', x, 0.15, z, 8)
    }
    if (debris) debris.burstChunks(x, 0.9, z, Math.round(9 * p), p, CHUNK.STEEL)
    if (rings) rings.addShockRing(x, z, 0.5, 3.2 * p, 0.40, TONE_FIRE)
    if (decals) decals.addScorch(x, z, 1.9 * p)
  }

  /** A barrel that reached the squad. Same materials, aimed at the player's plane. */
  function breach(x, z) {
    if (particles) {
      particles.burst('fire', x, 1.0, z, 10)
      particles.burst('smoke', x, 1.0, z, 10)
      particles.burst('ember', x, 1.0, z, 6)
      particles.burst('dust', x, 0.15, z, 10)
    }
    if (debris) debris.burstChunks(x, 0.9, z, 5, 0.8, CHUNK.STEEL)
    if (rings) rings.addShockRing(x, z, 0.5, 2.8, 0.36, TONE_FIRE)
    if (decals) decals.addScorch(x, z, 1.5)
  }

  /** Bubble shatter: the best half-second in the mode. Glass, not fire. */
  function bubble(x, y, z) {
    if (particles) {
      particles.burst('shard', x, y, z, 18)
      particles.burst('glint', x, y, z, 14)
      particles.burst('spark', x, y, z, 8)
    }
    if (rings) rings.addShockRing(x, z, 0.4, 2.6, 0.34, TONE_CYAN)
  }

  /** Acid landing on the road. `hit` means it caught someone. */
  function spitLand(x, z, hit) {
    if (particles) {
      particles.burst('bile', x, 0.25, z, hit ? 14 : 8)
      particles.burst('toxic', x, 0.35, z, hit ? 8 : 4)
    }
    if (rings) rings.addShockRing(x, z, 0.3, hit ? 2.2 : 1.5, 0.30, TONE_TOXIC)
    if (decals) decals.addBile(x, z, hit ? 1.5 : 1.0)
  }

  /**
   * A drone bolt going off. Deliberately CYAN and sparky rather than fiery: it
   * has to be legible as "your side did that" in a frame that may also contain a
   * bloater going off in orange two metres away.
   */
  function boltBurst(x, y, z, hit) {
    if (particles) {
      particles.burst('spark', x, y, z, hit > 0 ? 12 : 6)
      particles.burst('glint', x, y, z, 5)
      if (hit > 0) particles.burst('smoke', x, y, z, 4)
    }
    if (rings) rings.addShockRing(x, z, 0.15, hit > 0 ? 1.5 : 0.9, 0.24, TONE_CYAN)
    if (tracers) tracers.spawnFlash(x, y, z, 0.45, 0.82, 1.0, 0.95, 0.30, 0.09, 1.6)
  }

  /** A drone joining or leaving. One pop each, so both reads as an event. */
  function droneBeacon(x, y, z, up) {
    if (particles) particles.burst('glint', x, y, z, up ? 10 : 6)
    if (rings) rings.addShockRing(x, z, 0.2, up ? 1.9 : 1.2, 0.30, TONE_CYAN)
  }

  /** The squad taking off on wings: one big cyan ring under the formation. */
  function wingsUp(x, y, z) {
    if (particles) {
      particles.burst('glint', x, y, z, 18)
      particles.burst('spark', x, 0.4, z, 12)
    }
    if (rings) rings.addShockRing(x, z, 0.4, 3.0, 0.45, TONE_CYAN)
  }

  /** The spitter rearing back. Loud and early -- the windup IS the mechanic. */
  function spitWindup(x, y, z) {
    if (particles) particles.burst('bile', x, y, z, 4)
    if (tracers) {
      tracers.spawnFlash(x, y, z, 0.34, 0.34, 0.55, 0.95, 0.25, 0.10, 1.5)
    }
  }

  /** The projectile leaving. Small: the windup already spent the attention. */
  function spitFire(x, y, z) {
    if (particles) particles.burstDir('bile', x, y, z, 6, 0, 0, 3.0)
  }

  /** Boss death. Everything the barrel does, at boss scale, for a full second. */
  function bossDeath(x, z) {
    const h = CFG.boss.height * 0.3
    if (particles) {
      particles.burst('fire', x, h, z, 60)
      particles.burst('ember', x, h, z, 24)
      particles.burst('smoke', x, h, z, 30)
      particles.burst('plume', x, h + 1.0, z, 12)
      particles.burst('dust', x, 0.2, z, 20)
    }
    if (debris) debris.burstChunks(x, h, z, 16, 1.6, CHUNK.STEEL)
    if (rings) {
      // Two fronts, staggered: one blast ring reads as a decal appearing, two
      // read as a structure coming apart.
      rings.addShockRing(x, z, 1.0, 7.5, 0.55, TONE_FIRE)
      rings.addShockRing(x, z, 0.5, 4.5, 0.85, TONE_FIRE)
    }
    if (decals) decals.addScorch(x, z, 5.0)
  }

  /** A boss armour plate breaking off. */
  function bossPlate(x, y, z) {
    if (particles) {
      particles.burst('rico', x, y, z, 16)
      particles.burst('smoke', x, y, z, 5)
    }
    if (debris) debris.burstChunks(x, y, z, 5, 1.1, CHUNK.STEEL)
  }

  return {
    impact, kill, bloater, barrel, breach, bubble,
    spitLand, spitWindup, spitFire, bossDeath, bossPlate,
    boltBurst, droneBeacon, wingsUp,
  }
}
