/**
 * Marks left ON the road: blood under a kill, scorch under an explosion.
 *
 * Particles are the EVENT; a decal is the EVIDENCE. Without one, a corridor the
 * squad has fought its way down looks exactly like a corridor nothing has ever
 * happened in, and every kill is forgotten the frame its blood spray expires.
 * Decals are the only thing in the build that says "you did that" a second
 * later, and they cost one draw call.
 *
 * FOUR STAMPS IN ONE TEXTURE, selected per instance by a UV rect. Splat A, splat
 * B, a scorch burn and a scuff -- four separate textures would be four
 * materials and four draw calls for what is the same quad with a different
 * corner of the same 128px atlas.
 *
 * Coplanar with the road, so polygonOffset(-1, -1) and NEVER a y-lift: a lift
 * looks correct near the camera and z-fights at the far end of the corridor,
 * which is exactly where the player is reading.
 *
 * They scroll as a pure function of `w.distance`, matching the corridor: a
 * private dt integrator drifts against the sim within seconds, so a blood mark
 * would slowly swim away from the body that left it.
 */
import {
  ClampToEdgeWrapping, Color, DataTexture, DynamicDrawUsage, FrontSide,
  InstancedBufferAttribute, InstancedMesh, LinearFilter, LinearMipmapLinearFilter,
  Matrix4, PlaneGeometry, Quaternion, RGBAFormat, ShaderMaterial, SRGBColorSpace,
  Vector3,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'
import { Rng } from '../util/rng.js'

// --------------------------------------------------------------- frame scratch
const _m4 = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
const _quat = new Quaternion()
const _axisY = new Vector3(0, 1, 0)

const TAU = Math.PI * 2
const ATLAS = 128            // 2x2 cells of 64px
const HALF = 0.5

/** Stamp ids. Order is the atlas cell order; never reshuffle. */
export const STAMP = { SPLAT_A: 0, SPLAT_B: 1, SCORCH: 2, SCUFF: 3 }

const LIFE_BLOOD = 5.5
const LIFE_SCORCH = 8.0
const FADE_FRAC = 0.55       // fraction of life spent at full opacity

/**
 * Mark colours, resolved to the renderer's working space ONCE.
 *
 * The fragment shader ends with <colorspace_fragment>, so a literal 0..1 triple
 * written into the tint is treated as LINEAR and comes back out washed -- dark
 * maroon blood lands on the road as pink, which is exactly the bright red the
 * palette reserves for barrels. Conversion here is not a nicety.
 *
 * BLOOD IS DELIBERATELY DESATURATED. Sixty accumulated kill marks must never
 * start competing with the one object the player actually has to shoot.
 */
const HEX = { blood: 0x4a1f1a, bile: 0x2f4a10, scorch: 0x1a1512, scuff: 0x4d3f2e }
const MARK = {}
{
  const c = new Color()
  for (const k of Object.keys(HEX)) {
    c.setHex(HEX[k], SRGBColorSpace)
    MARK[k] = [c.r, c.g, c.b]
  }
}

/**
 * Bake the four stamps into ONE RGBA texture, once, at boot.
 *
 * Shape lives entirely in ALPHA with RGB left white so the sRGB transfer on the
 * colour map is a no-op and the falloff cannot be silently gamma-warped -- the
 * same discipline the ring sprites use.
 */
function bakeAtlas() {
  const data = new Uint8Array(ATLAS * ATLAS * 4)
  const rng = new Rng(0x3c81f5a9)
  const C = ATLAS / 2

  // Per-cell blob clusters. A single radial blob reads as a printed dot no
  // matter how it is tinted; an irregular cluster of overlapping lobes is what
  // makes a splat look like it landed rather than like it was placed.
  const cells = [
    { blobs: 7, spread: 0.30, rad: [0.06, 0.17], hard: 0.55 },   // splat A
    { blobs: 5, spread: 0.34, rad: [0.05, 0.21], hard: 0.45 },   // splat B
    { blobs: 9, spread: 0.24, rad: [0.10, 0.24], hard: 0.20 },   // scorch: soft, round
    { blobs: 4, spread: 0.36, rad: [0.04, 0.10], hard: 0.70 },   // scuff: sparse, hard
  ]

  for (let c = 0; c < 4; c++) {
    const spec = cells[c]
    const ox = (c % 2) * C
    const oy = ((c / 2) | 0) * C
    const bx = new Float32Array(spec.blobs)
    const by = new Float32Array(spec.blobs)
    const br = new Float32Array(spec.blobs)
    for (let b = 0; b < spec.blobs; b++) {
      const a = rng.next() * TAU
      const d = Math.sqrt(rng.next()) * spec.spread
      bx[b] = Math.cos(a) * d
      by[b] = Math.sin(a) * d
      br[b] = rng.range(spec.rad[0], spec.rad[1])
    }
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x + 0.5) / C - 0.5
        const v = (y + 0.5) / C - 0.5
        let a = 0
        for (let b = 0; b < spec.blobs; b++) {
          const dx = u - bx[b]
          const dy = v - by[b]
          const d = Math.sqrt(dx * dx + dy * dy) / br[b]
          if (d >= 1) continue
          const t = 1 - d
          // `hard` picks how much of the lobe is a plateau vs a falloff, which
          // is the difference between a wet splat edge and a soot cloud.
          const f = spec.hard + (1 - spec.hard) * (t * t * (3 - 2 * t))
          const s = t < 0.35 ? f * (t / 0.35) : f
          if (s > a) a = s
        }
        // Hard-cut at the cell edge: bilinear filtering would otherwise sample
        // a neighbouring stamp and grow a ghost lobe at mip level 1, i.e. at
        // exactly the distance where the corridor is densest.
        const edge = clamp((0.5 - Math.max(Math.abs(u), Math.abs(v))) / 0.06, 0, 1)
        const o = ((oy + y) * ATLAS + (ox + x)) * 4
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255
        data[o + 3] = clamp(Math.round(a * edge * 255), 0, 255)
      }
    }
  }

  const tex = new DataTexture(data, ATLAS, ATLAS, RGBAFormat)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

const VS = `
attribute vec4 aUv;
attribute vec4 aTint;
varying vec2 vAtlas;
varying vec4 vTint;
void main() {
  vAtlas = aUv.xy + uv * aUv.zw;
  vTint = aTint;
  #include <begin_vertex>
  #include <project_vertex>
}
`

const FS = `
uniform sampler2D uTex;
varying vec2 vAtlas;
varying vec4 vTint;
void main() {
  float a = texture2D(uTex, vAtlas).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vTint.rgb, a * vTint.a);
  #include <colorspace_fragment>
}
`

function makeDecal() {
  return {
    x: 0, z: 0, d0: 0, z0: 0, roll: 0, size: 1, life: 0, ttl: 1,
    stamp: 0, r: 0, g: 0, b: 0, a: 1,
  }
}

export function createDecals(scene) {
  const CAP = CFG.pool.decals
  const rng = new Rng(0x64b9d301)

  const tex = bakeAtlas()
  // Flat in the road plane, origin at its centre.
  const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)

  const uvAttr = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4)
  const tintAttr = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4)
  uvAttr.setUsage(DynamicDrawUsage)
  tintAttr.setUsage(DynamicDrawUsage)
  geo.setAttribute('aUv', uvAttr)
  geo.setAttribute('aTint', tintAttr)

  const mat = new ShaderMaterial({
    uniforms: { uTex: { value: tex } },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  const mesh = new InstancedMesh(geo, mat, CAP)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  // three culls against the geometry bounding sphere at the mesh origin, so the
  // entire set of marks disappears the instant the camera leans. Silent.
  mesh.frustumCulled = false
  mesh.count = 0
  // Under the rings (2) -- a ring is a live readout and must never be dimmed by
  // a mark that is only history.
  mesh.renderOrder = 1
  scene.add(mesh)

  const uvArr = uvAttr.array
  const tintArr = tintAttr.array

  const items = new Array(CAP)
  for (let i = 0; i < CAP; i++) items[i] = makeDecal()
  let live = 0
  // Sampled in sync() so the add* calls need no world reference of their own --
  // they arrive from the bus, which carries no `w`. A mark placed between two
  // syncs is at most one frame of scroll (0.3u) out of date, which is under a
  // tenth of the smallest stamp.
  let distance = 0

  function release(i) {
    const last = --live
    if (i !== last) {
      const tmp = items[i]
      items[i] = items[last]
      items[last] = tmp
    }
  }

  /** Oldest-out, never newest-dropped: fresh evidence beats stale evidence. */
  function acquire() {
    if (live < CAP) return items[live++]
    let oldest = 0
    let best = items[0].life
    for (let i = 1; i < live; i++) if (items[i].life < best) { best = items[i].life; oldest = i }
    return items[oldest]
  }

  function push(x, z, size, stamp, ttl, r, g, b, a) {
    const d = acquire()
    d.x = x
    d.z0 = z
    d.d0 = distance
    d.z = z
    d.roll = rng.next() * TAU
    d.size = size
    d.ttl = ttl
    d.life = ttl
    d.stamp = stamp
    d.r = r
    d.g = g
    d.b = b
    d.a = a
    return d
  }

  /**
   * Blood under a body. Dark and desaturated ON PURPOSE: bright red is the
   * barrel channel and it carries gameplay meaning, so sixty accumulated kill
   * marks must never start competing with the one object the player has to shoot.
   */
  function addBlood(x, z, size) {
    push(
      x, z, (size > 0 ? size : 1) * rng.range(0.85, 1.25),
      rng.next() < 0.5 ? STAMP.SPLAT_A : STAMP.SPLAT_B,
      LIFE_BLOOD, MARK.blood[0], MARK.blood[1], MARK.blood[2], 0.62,
    )
  }

  /** Toxic residue: the bloater's only lasting mark, and the spit's landing pool. */
  function addBile(x, z, size) {
    push(
      x, z, (size > 0 ? size : 1) * rng.range(0.9, 1.3),
      rng.next() < 0.5 ? STAMP.SPLAT_B : STAMP.SPLAT_A,
      LIFE_BLOOD, MARK.bile[0], MARK.bile[1], MARK.bile[2], 0.58,
    )
  }

  /** Burn under an explosion. Longer-lived than blood -- a crater outlasts a body. */
  function addScorch(x, z, size) {
    push(
      x, z, (size > 0 ? size : 1) * rng.range(0.9, 1.15),
      STAMP.SCORCH, LIFE_SCORCH, MARK.scorch[0], MARK.scorch[1], MARK.scorch[2], 0.70,
    )
    push(
      x, z, (size > 0 ? size : 1) * rng.range(1.5, 1.9),
      STAMP.SCUFF, LIFE_SCORCH, MARK.scuff[0], MARK.scuff[1], MARK.scuff[2], 0.34,
    )
  }

  function sync(w, dt) {
    distance = w.distance
    const despawn = CFG.world.despawnZ + 8

    for (let i = live - 1; i >= 0; i--) {
      const d = items[i]
      d.life -= dt
      // Pure function of w.distance, exactly like the corridor. Integrating
      // scroll*dt privately drifts against the sim and, worse, survives a
      // restart -- the marks would sit at the wrong z until they expired.
      d.z = d.z0 + (distance - d.d0)
      if (d.life <= 0 || d.z > despawn) release(i)
    }

    // Full rebuild over [0, live). release() swap-removes, so writing matrices
    // during the reap pass would leave a stale one at every backfilled index.
    let n = 0
    for (let i = 0; i < live; i++) {
      const d = items[i]
      const u = 1 - d.life / d.ttl
      const fade = u < FADE_FRAC ? 1 : 1 - (u - FADE_FRAC) / (1 - FADE_FRAC)
      // A mark also SPREADS slightly as it soaks in, which is what stops the
      // fade from reading as the decal simply being switched off.
      const s = d.size * (1 + 0.14 * u)
      _quat.setFromAxisAngle(_axisY, d.roll)
      _pos.set(d.x, 0, d.z)
      _scl.set(s, 1, s)
      _m4.compose(_pos, _quat, _scl)
      mesh.setMatrixAt(n, _m4)

      const cell = d.stamp
      const o4 = n * 4
      uvArr[o4] = (cell % 2) * HALF
      // DataTexture (unlike CanvasTexture) ships with flipY = FALSE, so data row
      // 0 really is v = 0 and the row index maps straight through. Copying the
      // atlas.js `1 - (row+1)*dv` form here would flip the pairs and stamp a
      // scorch where the blood should be -- with no error, just wrong marks.
      uvArr[o4 + 1] = ((cell / 2) | 0) * HALF
      uvArr[o4 + 2] = HALF
      uvArr[o4 + 3] = HALF
      tintArr[o4] = d.r
      tintArr[o4 + 1] = d.g
      tintArr[o4 + 2] = d.b
      tintArr[o4 + 3] = d.a * fade
      n++
    }

    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    // Own flags. Riding the matrix flag freezes every stamp and tint at its boot
    // value while the marks scroll -- identical grey blobs, and no error.
    uvAttr.needsUpdate = true
    tintAttr.needsUpdate = true
  }

  function reset() {
    live = 0
    distance = 0
    mesh.count = 0
  }

  function dispose() {
    scene.remove(mesh)
    mesh.dispose()
    geo.dispose()
    mat.dispose()
    tex.dispose()
  }

  return { addBlood, addBile, addScorch, sync, reset, dispose }
}
