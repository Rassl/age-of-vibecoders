/**
 * Procedural character geometry: one merged, vertex-coloured, limb-tagged
 * BufferGeometry per body kind, plus one per weapon tier.
 *
 * No scene, no state, no textures. Primitives are placed, given a BAKED vertex
 * colour and a per-vertex `limbId`, and concatenated into ONE non-indexed
 * BufferGeometry. Non-indexed because the merge is then a straight typed-array
 * copy with no index rebasing, and because flat shading needs per-face vertices
 * anyway.
 *
 * SILHOUETTE IS THE ENTIRE BUDGET. The camera sits high and behind, so at 60
 * units a body is roughly twenty pixels tall and every hue in the palette has
 * been eaten by fog. If two kinds read the same in black-on-white they are the
 * same enemy, whatever their tint says. So each kind gets its own OUTLINE, and
 * that outline is what the tri budget is spent on:
 *
 *   walker   upright hunch, wide shoulder yoke, two arm bars reaching at you
 *   runner   diagonal wedge, head leading low, arms swept BACK into two spikes
 *   brute    one hypertrophied shoulder ball against a plain one -- lopsided
 *   spitter  bulb belly under a long naked NECK: a lollipop on stilts
 *   bloater  a sphere on stubs, with hot seams that read before it detonates
 *
 * ROTATION SIGN. `pivotX/pivotY/pivotZ` are exactly three's `rotateX/Y/Z` about
 * an arbitrary pivot -- no hidden negation, because the vertex shader in
 * characters.js reimplements the same matrices and the two must agree. What
 * that means in practice, for a limb HANGING below its pivot:
 *
 *   pivotX(+a)  swings the free end toward -Z   (the soldier's forward)
 *   pivotX(-a)  swings the free end toward +Z   (every enemy's forward)
 *
 * and for a mass sitting ABOVE its pivot the two are swapped, which is why a
 * hunch and an arm reach on the same body carry opposite signs.
 *
 * FACING. Soldiers face -Z, down the corridor, away from the camera. Enemies
 * and the boss face +Z: they are walking INTO the lens, and their kind-specific
 * lean must be able to tip toward the camera (runner) or away from it (spitter
 * rearing back to spit) around that same neutral.
 */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, SphereGeometry, TorusGeometry,
} from 'three'
import { clamp } from '../util/math.js'

/**
 * Per-vertex limb tag. The shader branches on this, so the numbering is part of
 * the contract with characters.js: legs are 4/5, their shins 8/9, and EXTRA is
 * the one slot whose meaning is per-kind (spinning minigun barrels, the
 * bloater's seams, the spitter's sac).
 */
export const LIMB = {
  TORSO: 0, HEAD: 1, ARM_L: 2, ARM_R: 3, LEG_L: 4, LEG_R: 5,
  GUN: 6, EXTRA: 7, SHIN_L: 8, SHIN_R: 9,
}

/**
 * Rig pivots, in model space. characters.js compiles these straight into the
 * vertex shader, so a limb pivot can never drift away from the mesh it swings.
 * Every rig carries the SAME field names -- the shader is generated once and
 * fed a different rig per material.
 */
export const SOLDIER_RIG = {
  height: 1.70, hipY: 0.80, kneeY: 0.42, legX: 0.115,
  shoulderY: 1.30, shoulderX: 0.255, neckY: 1.36,
  gunX: 0.20, gunY: 1.24, muzzleZ: -0.52,
}

export const WALKER_RIG = {
  height: 1.85, hipY: 0.88, kneeY: 0.46, legX: 0.15,
  shoulderY: 1.66, shoulderX: 0.34, neckY: 1.56,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

export const RUNNER_RIG = {
  height: 1.74, hipY: 0.86, kneeY: 0.44, legX: 0.13,
  shoulderY: 1.50, shoulderX: 0.26, neckY: 1.42,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

export const BRUTE_RIG = {
  height: 2.10, hipY: 0.98, kneeY: 0.50, legX: 0.27,
  shoulderY: 1.82, shoulderX: 0.52, neckY: 1.70,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

export const SPITTER_RIG = {
  height: 1.98, hipY: 0.86, kneeY: 0.44, legX: 0.16,
  shoulderY: 1.34, shoulderX: 0.22, neckY: 1.40,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

export const BLOATER_RIG = {
  height: 1.58, hipY: 0.62, kneeY: 0.30, legX: 0.21,
  shoulderY: 1.14, shoulderX: 0.44, neckY: 1.32,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

export const BOSS_RIG = {
  height: 7.2, hipY: 3.10, kneeY: 1.55, legX: 0.78,
  shoulderY: 5.75, shoulderX: 1.95, neckY: 6.05,
  gunX: 0, gunY: 0, muzzleZ: 0,
}

/** Back-compat: the walker IS the old single zombie rig. */
export const ZOMBIE_RIG = WALKER_RIG

export const ENEMY_RIGS = {
  walker: WALKER_RIG, runner: RUNNER_RIG, brute: BRUTE_RIG,
  spitter: SPITTER_RIG, bloater: BLOATER_RIG,
}

const C_SOLDIER = {
  body: 0x3e5c78, helmet: 0x5b7ea0, pack: 0x2f4a63,
  arm: 0x37536d, leg: 0x35516b, boot: 0x27333f, gun: 0x24282e, gunHot: 0x3b4149,
}

// One family, five values. The hue never separates the kinds -- it only stops
// them looking like five different games.
const C_Z = {
  body: 0x7a8a6b, head: 0x93a182, shoulder: 0x869575,
  arm: 0x6e7d61, leg: 0x5c6a51, foot: 0x3f4839,
  lean: 0x8b9670, pale: 0x9aa483, dark: 0x55604a,
  sac: 0x93a758, sacDark: 0x6d7d40,
  seam: 0xe0642c, blister: 0xd8873a,
}

// Deep and saturated on purpose. The corridor's key light is warm and the
// pre-boss danger shift pushes it warmer still, so a mid-tone violet renders as
// cream -- and violet is the ONLY thing marking this silhouette as the boss.
const C_BOSS = {
  body: 0x5a3858, shoulder: 0x84517e, head: 0x3a2444,
  arm: 0x4a2f48, leg: 0x422a46, spike: 0x2a1a30,
}

const _col = new Color()

const box = (w, h, d) => new BoxGeometry(w, h, d)

/** Low-segment sphere. Every extra ring costs `count` triangles per instance. */
const ball = (r, wSeg, hSeg) => new SphereGeometry(r, wSeg, hSeg)

/** Open dome: the head box below it plugs the hole, so the cap is pure profit. */
const dome = (r, wSeg, hSeg) => new SphereGeometry(r, wSeg, hSeg, 0, Math.PI * 2, 0, Math.PI * 0.5)

/** Thin ring, used only for the bloater's seams. Radial 4 is enough at this size. */
const ring = (r, tube, seg) => new TorusGeometry(r, tube, 4, seg)

function pivotX(g, px, py, pz, a) {
  g.translate(-px, -py, -pz); g.rotateX(a); g.translate(px, py, pz); return g
}

function pivotZ(g, px, py, pz, a) {
  g.translate(-px, -py, -pz); g.rotateZ(a); g.translate(px, py, pz); return g
}

/**
 * Bake colour + limbId onto one primitive.
 *
 * The vertical gradient is free ambient occlusion: without it a flat-lit kit
 * turns into one solid blob once forty bodies overlap in fog, and no amount of
 * real lighting fixes that because the bodies shade each other identically.
 */
function tag(src, hex, limb, height) {
  const g = src.index ? src.toNonIndexed() : src
  if (g !== src) src.dispose()
  g.deleteAttribute('uv')
  const pos = g.attributes.position
  const n = pos.count
  const colors = new Float32Array(n * 3)
  const limbs = new Float32Array(n)
  _col.setHex(hex)
  for (let i = 0; i < n; i++) {
    const k = 0.70 + 0.30 * clamp(pos.getY(i) / height, 0, 1)
    colors[i * 3] = _col.r * k
    colors[i * 3 + 1] = _col.g * k
    colors[i * 3 + 2] = _col.b * k
    limbs[i] = limb
  }
  g.setAttribute('color', new BufferAttribute(colors, 3))
  g.setAttribute('limbId', new BufferAttribute(limbs, 1))
  return g
}

/**
 * Concatenate tagged parts into one geometry. Hand-rolled rather than
 * BufferGeometryUtils: four known attributes, all non-indexed, all Float32 --
 * the general merger's group/index bookkeeping would be dead weight.
 */
function merge(parts) {
  let total = 0
  for (let i = 0; i < parts.length; i++) total += parts[i].attributes.position.count

  const position = new Float32Array(total * 3)
  const normal = new Float32Array(total * 3)
  const color = new Float32Array(total * 3)
  const limbId = new Float32Array(total)

  let v = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const c = p.attributes.position.count
    position.set(p.attributes.position.array, v * 3)
    normal.set(p.attributes.normal.array, v * 3)
    color.set(p.attributes.color.array, v * 3)
    limbId.set(p.attributes.limbId.array, v)
    v += c
    p.dispose()
  }

  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(position, 3))
  out.setAttribute('normal', new BufferAttribute(normal, 3))
  out.setAttribute('color', new BufferAttribute(color, 3))
  out.setAttribute('limbId', new BufferAttribute(limbId, 1))
  out.computeBoundingSphere()
  return out
}

/**
 * A leg: thigh from the hip, shin from the knee, foot welded to the shin.
 *
 * Split at the knee because a straight pole swinging from the hip is the single
 * thing that makes a walk cycle read as "sliding": the eye tracks the foot, and
 * an unbent knee drags it through the ground on every return stride.
 */
function pushLeg(parts, side, rig, dims, colors, H) {
  const x = side * rig.legX
  const thighH = rig.hipY - rig.kneeY
  const shinH = rig.kneeY - dims.ankle
  const lid = side < 0 ? LIMB.LEG_L : LIMB.LEG_R
  const sid = side < 0 ? LIMB.SHIN_L : LIMB.SHIN_R
  parts.push(tag(box(dims.thighW, thighH, dims.thighD)
    .translate(x, rig.kneeY + thighH * 0.5, 0), colors.leg, lid, H))
  parts.push(tag(box(dims.shinW, shinH, dims.shinD)
    .translate(x, dims.ankle + shinH * 0.5, 0), colors.leg, sid, H))
  parts.push(tag(box(dims.footW, dims.ankle + 0.02, dims.footD)
    .translate(x, (dims.ankle + 0.02) * 0.5, dims.footZ), colors.foot, sid, H))
}

// ---------------------------------------------------------------- soldier ---

/**
 * Soldier: ~250 tris, 1.70u tall, 0.52u across the shoulders. Faces -Z.
 *
 * Read from behind, top down: a bright helmet dome (the brightest thing on the
 * model, so the eye counts heads), a backpack slab and a stub antenna that stop
 * the torso reading as a flat card, and BOTH arms locked across the weapon --
 * the left one crossing the chest to the fore-end. A swinging arm instantly
 * reads as "unarmed civilian" at this distance, so the arms only ever move with
 * the recoil spring. The gun itself is NOT here; it is a separate mesh
 * (buildGunGeometry) so the whole squad's silhouette changes on a tier-up.
 */
export function buildSoldierGeometry() {
  const c = C_SOLDIER
  const r = SOLDIER_RIG
  const H = r.height
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.155, thighD: 0.175, shinW: 0.135, shinD: 0.155,
    ankle: 0.10, footW: 0.175, footD: 0.26, footZ: -0.035,
  }, { leg: c.leg, foot: c.boot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.155, thighD: 0.175, shinW: 0.135, shinD: 0.155,
    ankle: 0.10, footW: 0.175, footD: 0.26, footZ: -0.035,
  }, { leg: c.leg, foot: c.boot }, H)

  parts.push(tag(box(0.38, 0.20, 0.24).translate(0, 0.88, 0), c.body, LIMB.TORSO, H))
  parts.push(tag(box(0.42, 0.46, 0.26).translate(0, 1.09, 0), c.body, LIMB.TORSO, H))
  parts.push(tag(box(0.52, 0.13, 0.25).translate(0, 1.315, 0), c.body, LIMB.TORSO, H))
  parts.push(tag(box(0.30, 0.28, 0.15).translate(0, 1.12, 0.155), c.pack, LIMB.TORSO, H))
  // The antenna costs 12 tris and is the only thing that breaks the flat top
  // line of the crowd when forty helmets overlap.
  parts.push(tag(box(0.032, 0.34, 0.032).translate(0.10, 1.44, 0.17), c.gun, LIMB.TORSO, H))

  parts.push(tag(box(0.19, 0.17, 0.19).translate(0, 1.45, 0), c.body, LIMB.HEAD, H))
  parts.push(tag(dome(0.145, 8, 2).scale(1, 1.17, 1).translate(0, 1.53, 0), c.helmet, LIMB.HEAD, H))

  // The firing arm is SHORT -- a stub bent at the elbow, tucked in at the grip;
  // the support arm is long and CROSSES the chest to the fore-end. That
  // asymmetry is what makes the pose read as "holding something" rather than
  // "arms out", and it survives being twenty pixels tall.
  //
  // Their free axes differ, which the shader relies on: the firing arm is
  // useful in PITCH (about X) and the support arm, lying almost along +X, is
  // useful in ROLL (about Z). Per-tier offsets are applied on exactly those.
  const sx = r.shoulderX
  const sy = r.shoulderY
  // Both angles are SOLVED, not eyeballed: the firing hand lands on the grip at
  // (0.20, 1.19, -0.21) and the support hand on the fore-end at (0.20, 1.20,
  // -0.40). A hand floating next to its weapon is the tell that the gun is a
  // separate mesh, and it is visible at any distance the gun itself is.
  parts.push(tag(pivotX(box(0.115, 0.22, 0.115).translate(sx, sy - 0.11, 0), sx, sy, 0, 1.10),
    c.arm, LIMB.ARM_R, H))
  parts.push(tag(pivotX(box(0.105, 0.12, 0.13).translate(sx, sy - 0.25, 0), sx, sy, 0, 1.10),
    c.boot, LIMB.ARM_R, H))
  parts.push(tag(pivotZ(pivotX(box(0.11, 0.58, 0.11).translate(-sx, sy - 0.29, 0), -sx, sy, 0, 0.71),
    -sx, sy, 0, 1.34), c.arm, LIMB.ARM_L, H))
  parts.push(tag(pivotZ(pivotX(box(0.105, 0.12, 0.13).translate(-sx, sy - 0.62, 0), -sx, sy, 0, 0.71),
    -sx, sy, 0, 1.34), c.boot, LIMB.ARM_L, H))

  return merge(parts)
}

// ------------------------------------------------------------------ guns ---

/**
 * Per-tier hand pose: `armL` ROLLS the support arm across or away from the
 * chest, `armR` PITCHES the firing arm. characters.js feeds them to the soldier
 * material as one vec2, so an upgrade re-poses the arms as well as swapping the
 * mesh -- the pistol drops the support hand entirely, the minigun braces both.
 * Without this a tier-up is a new prop held by an unchanged mannequin.
 */
export const GUN_POSES = [
  { armL: -1.05, armR: 0.14 },   // pistol: one-handed, the support arm falls away
  { armL: -0.22, armR: 0.05 },   // smg: tight and high, support hand near the mag
  { armL: 0.00, armR: 0.00 },    // rifle: the pose the mesh was authored on
  { armL: 0.12, armR: -0.07 },   // shotgun: support hand out on the pump
  { armL: 0.24, armR: -0.20 },   // minigun: both arms down and braced on the drum
]

/**
 * The five weapons, ~50-150 tris each, authored around the right hand at
 * (gunX, gunY) with the grip near z = -0.08.
 *
 * MUZZLES POINT AT OR PAST z = -0.52, never short of it, because that is where
 * combat.js casts the ray and where tracers.js spawns the flash. A tracer
 * starting inside a long barrel is invisible; a tracer starting in front of a
 * short one is a floating spark, so the pistol is the one that gets padded out
 * to reach the mark and everything longer simply overhangs it.
 *
 * Tier reads at 20 pixels: stub / boxy mag / long+scope / fat+pump / drum and
 * a barrel cluster. Length alone would not survive the foreshortening.
 */
export function buildGunGeometry(tier) {
  const c = C_SOLDIER
  const H = SOLDIER_RIG.height
  const gx = SOLDIER_RIG.gunX
  const gy = SOLDIER_RIG.gunY
  const parts = []
  const put = (g, hex, limb) => parts.push(tag(g, hex, limb, H))

  if (tier <= 0) {
    // Pistol: slide plus a stubby grip. Deliberately tiny -- it has to look
    // inadequate next to what replaces it.
    put(box(0.055, 0.085, 0.30).translate(gx, gy + 0.01, -0.30), c.gun, LIMB.GUN)
    put(box(0.05, 0.15, 0.075).translate(gx, gy - 0.09, -0.13), c.gun, LIMB.GUN)
    put(box(0.035, 0.035, 0.05).translate(gx, gy + 0.055, -0.42), c.gunHot, LIMB.GUN)
  } else if (tier === 1) {
    // SMG: the box magazine hanging under the receiver is the whole read.
    put(box(0.065, 0.10, 0.30).translate(gx, gy + 0.01, -0.26), c.gun, LIMB.GUN)
    put(box(0.038, 0.038, 0.20).translate(gx, gy + 0.02, -0.50), c.gun, LIMB.GUN)
    put(box(0.075, 0.24, 0.10).translate(gx, gy - 0.13, -0.22), c.gunHot, LIMB.GUN)
    put(box(0.05, 0.09, 0.16).translate(gx, gy - 0.01, -0.04), c.gun, LIMB.GUN)
  } else if (tier === 2) {
    // Rifle: long barrel past the mark, real stock behind the hand, and a
    // scope bump breaking the top line -- the three cues that say "rifle".
    put(box(0.048, 0.048, 0.46).translate(gx, gy + 0.03, -0.55), c.gun, LIMB.GUN)
    put(box(0.075, 0.13, 0.30).translate(gx, gy, -0.22), c.gun, LIMB.GUN)
    put(box(0.055, 0.055, 0.15).translate(gx, gy + 0.10, -0.24), c.gunHot, LIMB.GUN)
    put(box(0.038, 0.045, 0.07).translate(gx, gy + 0.065, -0.24), c.gun, LIMB.GUN)
    put(box(0.05, 0.16, 0.08).translate(gx, gy - 0.12, -0.20), c.gunHot, LIMB.GUN)
    put(box(0.06, 0.14, 0.26).translate(gx, gy - 0.05, 0.06), c.gun, LIMB.GUN)
  } else if (tier === 3) {
    // Shotgun: short, THICK, and the wide pump under the barrel is what tells
    // it apart from the rifle once the length is foreshortened away.
    put(box(0.085, 0.085, 0.40).translate(gx, gy + 0.03, -0.44), c.gun, LIMB.GUN)
    put(box(0.13, 0.10, 0.20).translate(gx, gy - 0.07, -0.40), c.gunHot, LIMB.GUN)
    put(box(0.10, 0.14, 0.24).translate(gx, gy - 0.01, -0.16), c.gun, LIMB.GUN)
    put(box(0.075, 0.15, 0.24).translate(gx, gy - 0.06, 0.06), c.gun, LIMB.GUN)
  } else {
    // Minigun. The six barrels are tagged EXTRA and spin about (gx, gy) in the
    // vertex shader; alternating light/dark barrels are what makes the spin
    // legible at distance, where the ring itself is only a few pixels across.
    put(box(0.22, 0.24, 0.30).translate(gx, gy - 0.02, -0.14), c.gun, LIMB.GUN)
    put(ball(0.13, 8, 5).scale(1, 1, 0.75).translate(gx - 0.10, gy - 0.13, 0.04), c.gunHot, LIMB.GUN)
    put(box(0.06, 0.16, 0.10).translate(gx + 0.02, gy - 0.20, -0.06), c.gun, LIMB.GUN)
    const R = 0.075
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      put(box(0.042, 0.042, 0.52).translate(gx + Math.cos(a) * R, gy + Math.sin(a) * R, -0.56),
        i % 2 ? c.gun : c.gunHot, LIMB.EXTRA)
    }
    put(box(0.20, 0.20, 0.06).translate(gx, gy, -0.31), c.gunHot, LIMB.EXTRA)
  }

  return merge(parts)
}

/** All five, in tier order. characters.js swaps them on one InstancedMesh. */
export function buildGunGeometries() {
  const out = []
  for (let i = 0; i < 5; i++) out.push(buildGunGeometry(i))
  return out
}

// --------------------------------------------------------------- enemies ---

/**
 * Walker: ~240 tris, 1.85u. The crowd, and therefore the baseline every other
 * kind is read AGAINST -- so it is the plainest of the five on purpose.
 *
 * A bare ball head sunk BELOW the shoulder yoke and pushed toward the camera, a
 * baked hunch, and two arm bars reaching out at the squad. Two horizontal bars
 * leaving the shoulders is the most readable enemy cue at distance, more
 * readable than the body behind them.
 */
export function buildWalkerGeometry() {
  const r = WALKER_RIG
  const H = r.height
  const hip = r.hipY
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.17, thighD: 0.19, shinW: 0.15, shinD: 0.17,
    ankle: 0.10, footW: 0.19, footD: 0.28, footZ: 0.045,
  }, { leg: C_Z.leg, foot: C_Z.foot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.17, thighD: 0.19, shinW: 0.15, shinD: 0.17,
    ankle: 0.10, footW: 0.19, footD: 0.28, footZ: 0.045,
  }, { leg: C_Z.leg, foot: C_Z.foot }, H)

  // Everything above the hip carries a baked hunch toward the camera. Per-KIND
  // lean rides on the instance matrix on top of this.
  const hunch = 0.17
  parts.push(tag(pivotX(box(0.40, 0.22, 0.28).translate(0, 0.96, 0), 0, hip, 0, hunch),
    C_Z.body, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.44, 0.56, 0.31).translate(0, 1.32, 0), 0, hip, 0, hunch),
    C_Z.body, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.72, 0.22, 0.33).translate(0, 1.68, 0), 0, hip, 0, hunch),
    C_Z.shoulder, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.12, 6, 3).translate(-0.34, 1.68, 0), 0, hip, 0, hunch),
    C_Z.shoulder, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.12, 6, 3).translate(0.34, 1.68, 0), 0, hip, 0, hunch),
    C_Z.shoulder, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.155, 6, 4).translate(0, 1.60, 0.20), 0, hip, 0, hunch),
    C_Z.head, LIMB.HEAD, H))

  // Arms reach at the squad (-a, toward +Z) and are splayed outward so they
  // clear the torso in a top-down read instead of hiding behind it. The left
  // one hangs 0.2 rad lower: the asymmetry is the first hint of the limp that
  // the gait then completes.
  const sy = r.shoulderY
  const sx = r.shoulderX
  parts.push(tag(pivotZ(pivotX(box(0.14, 0.58, 0.14).translate(-sx, sy - 0.29, 0), -sx, sy, 0, -1.28),
    -sx, sy, 0, -0.24), C_Z.arm, LIMB.ARM_L, H))
  parts.push(tag(pivotZ(pivotX(box(0.13, 0.16, 0.15).translate(-sx, sy - 0.61, 0), -sx, sy, 0, -1.28),
    -sx, sy, 0, -0.24), C_Z.dark, LIMB.ARM_L, H))
  parts.push(tag(pivotZ(pivotX(box(0.14, 0.58, 0.14).translate(sx, sy - 0.29, 0), sx, sy, 0, -1.08),
    sx, sy, 0, 0.24), C_Z.arm, LIMB.ARM_R, H))
  parts.push(tag(pivotZ(pivotX(box(0.13, 0.16, 0.15).translate(sx, sy - 0.61, 0), sx, sy, 0, -1.08),
    sx, sy, 0, 0.24), C_Z.dark, LIMB.ARM_R, H))

  return merge(parts)
}

/**
 * Runner: ~210 tris, 1.74u but read as SHORTER because of the pitch.
 *
 * Every proportion is the walker's inverted: narrow shoulders, thin limbs, a
 * head that LEADS the body instead of sitting under it, and arms swept back
 * with a folded elbow so the silhouette is a wedge with two spikes behind it.
 * A player who has learned "wide and upright = walker" reads this as the
 * opposite before consciously identifying it.
 */
export function buildRunnerGeometry() {
  const r = RUNNER_RIG
  const H = r.height
  const hip = r.hipY
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.135, thighD: 0.16, shinW: 0.115, shinD: 0.14,
    ankle: 0.09, footW: 0.15, footD: 0.30, footZ: 0.07,
  }, { leg: C_Z.lean, foot: C_Z.foot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.135, thighD: 0.16, shinW: 0.115, shinD: 0.14,
    ankle: 0.09, footW: 0.15, footD: 0.30, footZ: 0.07,
  }, { leg: C_Z.lean, foot: C_Z.foot }, H)

  // A baked pitch ON TOP of the instance lean from data/enemies.js (0.50 for
  // this kind): together they put the head most of a body-length in front of
  // the feet, which is the sprint read. Kept well under 45 degrees total --
  // past that it stops reading as running and starts reading as falling.
  const pitch = 0.24
  parts.push(tag(pivotX(box(0.30, 0.20, 0.24).translate(0, 0.94, 0), 0, hip, 0, pitch),
    C_Z.lean, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.32, 0.50, 0.26).translate(0, 1.26, 0), 0, hip, 0, pitch),
    C_Z.lean, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.50, 0.18, 0.26).translate(0, 1.50, 0), 0, hip, 0, pitch),
    C_Z.pale, LIMB.TORSO, H))
  // Ribs: a hard highlight band that catches the eye as the body rolls.
  parts.push(tag(pivotX(box(0.34, 0.06, 0.28).translate(0, 1.14, 0), 0, hip, 0, pitch),
    C_Z.pale, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.13, 0.20, 0.16).translate(0, 1.46, 0.16), 0, hip, 0, pitch),
    C_Z.head, LIMB.HEAD, H))
  parts.push(tag(pivotX(ball(0.145, 6, 4).scale(1, 0.9, 1.25).translate(0, 1.44, 0.30), 0, hip, 0, pitch),
    C_Z.head, LIMB.HEAD, H))

  const sy = r.shoulderY
  const sx = r.shoulderX
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1
    const id = i === 0 ? LIMB.ARM_L : LIMB.ARM_R
    // Upper arm back and out, forearm folded up behind it: two segments, one
    // limb id, so the pump swings the whole spike as a unit.
    parts.push(tag(pivotZ(pivotX(box(0.10, 0.32, 0.10).translate(side * sx, sy - 0.16, 0),
      side * sx, sy, 0, 1.05), side * sx, sy, 0, side * -0.18), C_Z.arm, id, H))
    parts.push(tag(pivotZ(pivotX(box(0.09, 0.30, 0.09).translate(side * sx, sy - 0.44, 0),
      side * sx, sy, 0, 2.45), side * sx, sy, 0, side * -0.18), C_Z.arm, id, H))
  }

  return merge(parts)
}

/**
 * Brute: ~270 tris, 2.10u before the 1.45 kind scale -- roughly 3u in world,
 * twice a soldier.
 *
 * ONE hypertrophied shoulder ball against a plain block on the other side. The
 * asymmetry is the entire trick: a symmetric kit scaled up reads as a big
 * walker, never as a brute, because the eye has no landmark to measure it
 * against. The head is deliberately tiny and sunk between the two, which is
 * what sells the mass.
 */
export function buildBruteGeometry() {
  const r = BRUTE_RIG
  const H = r.height
  const hip = r.hipY
  const parts = []

  // Wide feet, but not DEEP ones: everything a foot overhangs behind the ankle
  // is driven under the road when that leg trails, and the brute is the kind
  // with both the longest stride and the heaviest drop.
  pushLeg(parts, -1, r, {
    thighW: 0.30, thighD: 0.34, shinW: 0.27, shinD: 0.30,
    ankle: 0.13, footW: 0.36, footD: 0.38, footZ: 0.05,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.30, thighD: 0.34, shinW: 0.27, shinD: 0.30,
    ankle: 0.13, footW: 0.36, footD: 0.38, footZ: 0.05,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)

  const hunch = 0.12
  parts.push(tag(pivotX(box(0.68, 0.28, 0.44).translate(0, 1.08, 0), 0, hip, 0, hunch),
    C_Z.dark, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.80, 0.62, 0.50).translate(0, 1.50, 0), 0, hip, 0, hunch),
    C_Z.body, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.86, 0.16, 0.44).translate(0, 1.80, -0.02), 0, hip, 0, hunch),
    C_Z.dark, LIMB.TORSO, H))
  // The lopsided pair. Ball on the right, plain slab on the left.
  parts.push(tag(pivotX(ball(0.40, 8, 5).scale(1, 0.92, 1).translate(0.56, 1.86, 0.02), 0, hip, 0, hunch),
    C_Z.shoulder, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.17, 6, 4).translate(0.66, 2.06, 0.10), 0, hip, 0, hunch),
    C_Z.pale, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.34, 0.30, 0.36).translate(-0.48, 1.74, 0), 0, hip, 0, hunch),
    C_Z.dark, LIMB.TORSO, H))
  // Back spikes break the top line so the mass does not read as a crate.
  parts.push(tag(pivotX(box(0.10, 0.30, 0.10).translate(-0.16, 1.92, -0.18), 0, hip, 0, hunch),
    C_Z.foot, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.09, 0.22, 0.09).translate(0.10, 1.86, -0.20), 0, hip, 0, hunch),
    C_Z.foot, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.16, 6, 4).translate(0, 1.70, 0.20), 0, hip, 0, hunch),
    C_Z.head, LIMB.HEAD, H))

  const sy = r.shoulderY
  // The heavy arm is nearly straight and hangs past the knee; the light one is
  // half its width. Same asymmetry as the shoulders, one level down.
  parts.push(tag(pivotX(box(0.34, 0.92, 0.36).translate(0.60, sy - 0.50, 0), 0.60, sy, 0, -0.30),
    C_Z.arm, LIMB.ARM_R, H))
  parts.push(tag(pivotX(ball(0.20, 6, 4).translate(0.60, sy - 1.00, 0), 0.60, sy, 0, -0.30),
    C_Z.dark, LIMB.ARM_R, H))
  parts.push(tag(pivotX(box(0.22, 0.80, 0.24).translate(-0.50, sy - 0.44, 0), -0.50, sy, 0, -0.55),
    C_Z.arm, LIMB.ARM_L, H))
  parts.push(tag(pivotX(box(0.20, 0.16, 0.22).translate(-0.50, sy - 0.90, 0), -0.50, sy, 0, -0.55),
    C_Z.dark, LIMB.ARM_L, H))

  return merge(parts)
}

/**
 * Spitter: ~250 tris, 1.98u to the top of the neck.
 *
 * A lollipop on stilts. The distended sac hangs low and forward, the chest
 * above it is nothing, and a long naked NECK carries the head half a metre
 * clear of the shoulders. Neck and head share LIMB.HEAD and pivot at neckY, so
 * the rear-back before a shot swings the single most identifiable part of the
 * body through the biggest arc on screen -- which is what has to sell "this one
 * is not walking at me" from across the corridor.
 *
 * The sac is LIMB.EXTRA: it inflates through the windup.
 */
export function buildSpitterGeometry() {
  const r = SPITTER_RIG
  const H = r.height
  const hip = r.hipY
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.115, thighD: 0.135, shinW: 0.10, shinD: 0.12,
    ankle: 0.08, footW: 0.14, footD: 0.26, footZ: 0.05,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.115, thighD: 0.135, shinW: 0.10, shinD: 0.12,
    ankle: 0.08, footW: 0.14, footD: 0.26, footZ: 0.05,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)

  const stoop = 0.30
  parts.push(tag(pivotX(box(0.26, 0.18, 0.22).translate(0, 0.92, 0), 0, hip, 0, stoop),
    C_Z.dark, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.28, 0.36, 0.24).translate(0, 1.20, 0), 0, hip, 0, stoop),
    C_Z.body, LIMB.TORSO, H))
  parts.push(tag(pivotX(box(0.40, 0.13, 0.22).translate(0, 1.36, 0), 0, hip, 0, stoop),
    C_Z.pale, LIMB.TORSO, H))
  parts.push(tag(pivotX(ball(0.30, 8, 5).scale(1.05, 0.92, 1.1).translate(0, 1.06, 0.16), 0, hip, 0, stoop),
    C_Z.sac, LIMB.EXTRA, H))
  parts.push(tag(pivotX(ball(0.13, 6, 3).translate(0, 0.88, 0.30), 0, hip, 0, stoop),
    C_Z.sacDark, LIMB.EXTRA, H))

  // Neck + head, one limb, pivoting at the base of the neck.
  const ny = r.neckY
  parts.push(tag(box(0.10, 0.44, 0.11).translate(0, ny + 0.22, 0.04), C_Z.pale, LIMB.HEAD, H))
  parts.push(tag(ball(0.135, 6, 4).translate(0, ny + 0.50, 0.06), C_Z.head, LIMB.HEAD, H))
  parts.push(tag(box(0.09, 0.09, 0.16).translate(0, ny + 0.47, 0.18), C_Z.sac, LIMB.HEAD, H))

  const sy = r.shoulderY
  const sx = r.shoulderX
  // Vestigial arms, tucked. They must not compete with the neck for attention.
  parts.push(tag(pivotX(box(0.09, 0.34, 0.09).translate(-sx, sy - 0.18, 0), -sx, sy, 0, -0.55),
    C_Z.arm, LIMB.ARM_L, H))
  parts.push(tag(pivotX(box(0.09, 0.34, 0.09).translate(sx, sy - 0.18, 0), sx, sy, 0, -0.40),
    C_Z.arm, LIMB.ARM_R, H))

  return merge(parts)
}

/**
 * Bloater: ~330 tris, 1.58u but almost as wide as it is tall.
 *
 * A sphere on stubs -- the only round silhouette in the game, which is the
 * whole point: it has to be identifiable in the frame BEFORE it dies, because
 * the information the player needs ("do not let this one reach the crowd, and
 * do not stand next to it") is only useful in advance.
 *
 * The seam rings and blisters are LIMB.EXTRA and glow hotter as its HP drops,
 * so a nearly-dead bloater is visibly primed.
 */
export function buildBloaterGeometry() {
  const r = BLOATER_RIG
  const H = r.height
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.22, thighD: 0.24, shinW: 0.21, shinD: 0.23,
    ankle: 0.09, footW: 0.26, footD: 0.30, footZ: 0.04,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.22, thighD: 0.24, shinW: 0.21, shinD: 0.23,
    ankle: 0.09, footW: 0.26, footD: 0.30, footZ: 0.04,
  }, { leg: C_Z.dark, foot: C_Z.foot }, H)

  const bodyY = 1.02
  parts.push(tag(ball(0.52, 9, 6).scale(1.06, 0.98, 1.0).translate(0, bodyY, 0),
    C_Z.body, LIMB.TORSO, H))
  parts.push(tag(ball(0.20, 6, 4).translate(0, bodyY + 0.44, 0.14), C_Z.head, LIMB.HEAD, H))

  // One horizontal seam and three blisters. Kept to four pieces because every
  // ring is 96 tris and there can be twenty of these on screen.
  parts.push(tag(ring(0.50, 0.055, 12).rotateX(Math.PI * 0.5).translate(0, bodyY - 0.06, 0),
    C_Z.seam, LIMB.EXTRA, H))
  parts.push(tag(ball(0.13, 5, 3).translate(-0.30, bodyY + 0.28, 0.34), C_Z.blister, LIMB.EXTRA, H))
  parts.push(tag(ball(0.15, 5, 3).translate(0.34, bodyY + 0.16, 0.32), C_Z.blister, LIMB.EXTRA, H))
  parts.push(tag(ball(0.11, 5, 3).translate(0.10, bodyY + 0.44, 0.30), C_Z.blister, LIMB.EXTRA, H))

  // Stub arms, splayed sideways: they cannot reach around the belly, and that
  // uselessness is what makes the mass read.
  const sy = r.shoulderY
  const sx = r.shoulderX
  parts.push(tag(pivotZ(pivotX(box(0.14, 0.34, 0.14).translate(-sx, sy - 0.17, 0.10), -sx, sy, 0.10, -0.75),
    -sx, sy, 0.10, -0.55), C_Z.arm, LIMB.ARM_L, H))
  parts.push(tag(pivotZ(pivotX(box(0.14, 0.34, 0.14).translate(sx, sy - 0.17, 0.10), sx, sy, 0.10, -0.75),
    sx, sy, 0.10, 0.55), C_Z.arm, LIMB.ARM_R, H))

  return merge(parts)
}

/** Back-compat alias: the walker is the original zombie. */
export const buildZombieGeometry = buildWalkerGeometry

/**
 * Boss: ~430 tris, 7.2u tall. One mesh, one draw call, so it can afford rings.
 *
 * Same vocabulary as the brute one order of magnitude up, and it faces +Z with
 * everything else that walks at the squad: back spikes behind, head pushed
 * toward the camera, so the death topple reads as falling TOWARD the player.
 */
export function buildBossGeometry() {
  const c = C_BOSS
  const r = BOSS_RIG
  const H = r.height
  const parts = []

  pushLeg(parts, -1, r, {
    thighW: 0.95, thighD: 1.05, shinW: 0.88, shinD: 0.98,
    ankle: 0.35, footW: 1.05, footD: 1.50, footZ: 0.18,
  }, { leg: c.leg, foot: c.spike }, H)
  pushLeg(parts, 1, r, {
    thighW: 0.95, thighD: 1.05, shinW: 0.88, shinD: 0.98,
    ankle: 0.35, footW: 1.05, footD: 1.50, footZ: 0.18,
  }, { leg: c.leg, foot: c.spike }, H)

  parts.push(tag(box(2.10, 0.90, 1.30).translate(0, 3.35, 0), c.body, LIMB.TORSO, H))
  parts.push(tag(box(2.70, 2.45, 1.60).translate(0, 4.85, 0), c.body, LIMB.TORSO, H))
  parts.push(tag(box(0.55, 1.70, 0.55).translate(0, 5.90, -0.80), c.spike, LIMB.TORSO, H))
  parts.push(tag(box(0.40, 1.10, 0.40).translate(-0.85, 5.60, -0.70), c.spike, LIMB.TORSO, H))

  parts.push(tag(ball(1.05, 12, 8).translate(1.95, 5.85, -0.05), c.shoulder, LIMB.TORSO, H))
  parts.push(tag(box(1.00, 0.85, 1.00).translate(-1.70, 5.75, 0), c.body, LIMB.TORSO, H))

  parts.push(tag(pivotX(box(0.95, 2.60, 1.00).translate(2.10, 4.30, 0), 2.10, 5.60, 0, -0.35),
    c.arm, LIMB.ARM_R, H))
  parts.push(tag(pivotX(box(0.55, 2.30, 0.60).translate(-1.75, 4.35, 0), -1.75, 5.50, 0, -0.45),
    c.arm, LIMB.ARM_L, H))

  parts.push(tag(ball(0.60, 10, 6).translate(-0.25, 6.60, 0.25), c.head, LIMB.HEAD, H))

  return merge(parts)
}
