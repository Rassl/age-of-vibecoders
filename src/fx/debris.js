/**
 * Tumbling solid chunks: barrel plating, boss armour, bloater gibs.
 *
 * A fireball is light and a smoke puff is a gradient; neither has MASS. Solid
 * lit geometry that spins, falls, hits the road and bounces is the only element
 * in an explosion that tells the eye the thing was made of something. It is also
 * the cheapest weight in the build -- one instanced 12-triangle chunk, one draw
 * call, no shadow map, no physics engine.
 *
 * LIT, NOT ADDITIVE. Everything else in fx/ emits light; chunks must RECEIVE it,
 * off the corridor's existing hemisphere + key pair, or they read as more
 * sparks. The material is the same MeshLambertMaterial family the corridor uses,
 * so a chunk's three faces land on three distinct values with no extra work.
 *
 * The tumble is stored as a fixed axis plus an integrated angle rather than a
 * per-instance quaternion: an axis-angle can never accumulate the normalisation
 * drift that turns a long-lived quaternion into a slowly shearing scale, and it
 * is 4 floats instead of 4 plus a renormalise.
 */
import {
  BoxGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh,
  Matrix4, MeshLambertMaterial, Quaternion, Vector3,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'
import { Rng } from '../util/rng.js'

// --------------------------------------------------------------- frame scratch
const _m4 = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
const _quat = new Quaternion()
const _axis = new Vector3(0, 1, 0)

const TAU = Math.PI * 2
const GROUND = 0.04
const GRAVITY = -21
const BOUNCE = 0.30
const FRICTION = 0.62
const SHRINK = 0.35        // seconds of shrink-out at the end of life

/**
 * Chunk tones. Value, not hue, does the separating: charred steel against sand
 * is a silhouette, and that survives fog, distance and a colour-blind player.
 */
export const CHUNK = { STEEL: 0, FLESH: 1, BONE: 2 }
const TONE = [
  [0.16, 0.14, 0.13],   // steel: charred, nearly black -- barrel and boss plate
  [0.20, 0.28, 0.07],   // flesh: bloater gib, the toxic green at low value
  [0.62, 0.58, 0.46],   // bone: pale, for the odd bright fleck in a body blast
]

function makeChunk() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    ax: 0, ay: 1, az: 0, spin: 0, angle: 0,
    sx: 1, sy: 1, sz: 1, life: 0, tone: 0, tint: 1,
  }
}

/**
 * An irregular hexahedron: a unit box whose eight corners are pushed around by a
 * seeded RNG, then re-normalled flat. A plain box reads as a crate the moment
 * two of its parallel edges line up on screen, and one broken silhouette is
 * cheaper than eight instances of variation.
 */
function buildChunkGeometry() {
  const g = new BoxGeometry(1, 1, 1).toNonIndexed()
  const pos = g.attributes.position.array
  const rng = new Rng(0x0b57e91d)
  // Corner-keyed jitter: vertices are duplicated per face, so jittering each
  // vertex independently would tear the faces apart at the seams.
  const key = new Map()
  for (let i = 0; i < pos.length; i += 3) {
    const k = `${Math.sign(pos[i])}${Math.sign(pos[i + 1])}${Math.sign(pos[i + 2])}`
    let off = key.get(k)
    if (!off) {
      off = [rng.range(-0.22, 0.22), rng.range(-0.22, 0.22), rng.range(-0.22, 0.22)]
      key.set(k, off)
    }
    pos[i] += off[0]
    pos[i + 1] += off[1]
    pos[i + 2] += off[2]
  }
  g.computeVertexNormals()
  return g
}

export function createDebris(scene) {
  const CAP = CFG.pool.chunks
  const rng = new Rng(0x2ab4f107)

  const geo = buildChunkGeometry()
  const mat = new MeshLambertMaterial({ color: 0xffffff })

  const mesh = new InstancedMesh(geo, mat, CAP)
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceColor.setUsage(DynamicDrawUsage)
  // three culls against the geometry bounding sphere sitting at the mesh origin,
  // so every chunk in flight vanishes at once the moment the camera leans.
  mesh.frustumCulled = false
  mesh.count = 0
  mesh.renderOrder = 1
  scene.add(mesh)

  const colArr = mesh.instanceColor.array
  const items = new Array(CAP)
  for (let i = 0; i < CAP; i++) items[i] = makeChunk()
  let live = 0

  function release(i) {
    const last = --live
    if (i !== last) {
      const tmp = items[i]
      items[i] = items[last]
      items[last] = tmp
    }
  }

  /**
   * Evict the OLDEST when full rather than dropping the new burst.
   *
   * particles.js does the opposite for a good reason (stealing slots would gut
   * an explosion still mid-flight), but chunks are the opposite case: the pool
   * is 24, one barrel wants 10, and dropping the newest means the second barrel
   * of a pair throws nothing at all -- which is far more noticeable than a chunk
   * from the first one disappearing a second early.
   */
  function acquire() {
    if (live < CAP) return items[live++]
    let oldest = 0
    let best = items[0].life
    for (let i = 1; i < live; i++) if (items[i].life < best) { best = items[i].life; oldest = i }
    return items[oldest]
  }

  /**
   * Throw `n` chunks out of a point.
   * @param {number} power scales both launch speed and chunk size, so a barrel
   *   and a bloater can share one emitter without sharing a look
   * @param {number} tone one of CHUNK
   */
  function burstChunks(x, y, z, n, power, tone) {
    const p = power > 0 ? power : 1
    const t = tone >= 0 && tone < TONE.length ? tone | 0 : 0
    for (let k = 0; k < n; k++) {
      const c = acquire()
      const a = rng.next() * TAU
      const cu = rng.range(-0.15, 1.0)         // biased UP: debris arcs, it does not spray down
      const su = Math.sqrt(clamp(1 - cu * cu, 0, 1))
      const sp = rng.range(3.5, 10.5) * p
      c.x = x + rng.range(-0.25, 0.25)
      c.y = y + rng.range(-0.2, 0.35)
      c.z = z + rng.range(-0.25, 0.25)
      c.vx = Math.cos(a) * su * sp
      c.vy = (cu * 0.85 + 0.55) * sp
      c.vz = Math.sin(a) * su * sp
      const jx = rng.range(-1, 1), jy = rng.range(-1, 1), jz = rng.range(-1, 1)
      const inv = 1 / Math.max(0.001, Math.sqrt(jx * jx + jy * jy + jz * jz))
      c.ax = jx * inv; c.ay = jy * inv; c.az = jz * inv
      c.spin = rng.range(7, 17) * rng.sign()
      c.angle = rng.range(0, TAU)
      // Non-uniform scale: shards, wedges and slabs out of one geometry.
      const base = rng.range(0.10, 0.24) * p
      c.sx = base * rng.range(0.5, 1.6)
      c.sy = base * rng.range(0.5, 1.6)
      c.sz = base * rng.range(0.5, 1.6)
      c.life = rng.range(1.5, 2.6)
      c.tone = t
      c.tint = rng.range(0.75, 1.30)
    }
  }

  function sync(w, dt) {
    const scroll = w.scroll
    for (let i = live - 1; i >= 0; i--) {
      const c = items[i]
      c.life -= dt
      if (c.life <= 0) { release(i); continue }
      c.vy += GRAVITY * dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      // Everything resting on the corridor moves with it; a chunk that ignored
      // the scroll would visibly swim upstream against the road stripes.
      c.z += (c.vz + scroll) * dt
      c.angle += c.spin * dt
      if (c.y < GROUND) {
        c.y = GROUND
        if (c.vy < 0) {
          c.vy *= -BOUNCE
          c.vx *= FRICTION
          c.vz *= FRICTION
          c.spin *= FRICTION
        }
      }
    }

    // Full rebuild over [0, live): release() swap-removes, so any matrix written
    // during the reap pass above would be stale at every backfilled index.
    for (let i = 0; i < live; i++) {
      const c = items[i]
      // Shrink out rather than fade: the material is opaque and lit, and an
      // alpha fade would mean a second transparent material and a second draw
      // call for the last 0.35s of a chunk nobody is looking at any more.
      const k = clamp(c.life / SHRINK, 0, 1)
      _axis.set(c.ax, c.ay, c.az)
      _quat.setFromAxisAngle(_axis, c.angle)
      _pos.set(c.x, c.y, c.z)
      _scl.set(c.sx * k, c.sy * k, c.sz * k)
      _m4.compose(_pos, _quat, _scl)
      mesh.setMatrixAt(i, _m4)

      const tone = TONE[c.tone]
      const o = i * 3
      colArr[o] = tone[0] * c.tint
      colArr[o + 1] = tone[1] * c.tint
      colArr[o + 2] = tone[2] * c.tint
    }

    mesh.count = live
    mesh.instanceMatrix.needsUpdate = true
    // Its OWN flag. Riding instanceMatrix.needsUpdate freezes every chunk at its
    // boot tint while the geometry keeps tumbling -- black debris, no error.
    mesh.instanceColor.needsUpdate = true
  }

  function reset() {
    live = 0
    mesh.count = 0
  }

  function dispose() {
    scene.remove(mesh)
    mesh.dispose()
    geo.dispose()
    mat.dispose()
  }

  return { burstChunks, sync, reset, dispose }
}
