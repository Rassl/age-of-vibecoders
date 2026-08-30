/**
 * Every particle in the game in ONE Points cloud, one draw call, one upload.
 *
 * A barrel explosion (fire + smoke + debris) lands in the same frame as twenty
 * soldiers' impact sparks and a zombie death. As separate emitters that is a
 * dozen draw calls and a dozen buffer uploads at the exact moment the frame is
 * already the most expensive it will ever be -- so there is one cloud and the
 * kind is data, never a second object.
 *
 * MIXED BLENDING FROM ONE MATERIAL. Sparks, fire and shards must be additive;
 * blood, smoke and dust must NOT be -- additive dark is very nearly a no-op, so
 * blood over sand would simply not exist. A single draw call serves both by
 * writing PREMULTIPLIED colour and using the fragment's own output alpha as the
 * blend selector: NormalBlending + premultipliedAlpha is
 * glBlendFunc(ONE, ONE_MINUS_SRC_ALPHA), so alpha 0 leaves the destination
 * untouched (pure additive) while alpha 1 is a normal over. `aMode` is that
 * switch, and it is why blood can be a dark smear in the same cloud as a spark.
 *
 * The pool is a contiguous live prefix with swap-remove, exactly like the sim
 * pools, so the update is one flat allocation-free loop and the GPU upload is
 * always a single range [0, live).
 */
import * as THREE from 'three'
import { CFG } from '../config.js'
import { Rng } from '../util/rng.js'

const TAU = Math.PI * 2

// Fragment output alpha doubles as the blend mode: 0 additive, 1 alpha-over.
const ADD = 0
const OVER = 1

/** Particles below this are on the road; they skid instead of sinking through it. */
const GROUND_Y = 0.035

/**
 * Spawn recipes. `ramp` is three sRGB stops walked over normalised life, `grow`
 * the end/start size ratio, `curve` the alpha shape (2 holds then drops, 1 is
 * linear, 0 dies early), `yBias`/`zBias` push the spawn cone up and toward the
 * camera, `jit` is spawn scatter so a burst is not a visible point source.
 */
const KINDS = {
  // Bullet impacts. Short, hot, and thrown back toward the shooter.
  spark: {
    n: 6, mode: ADD, ramp: [0xfff4cf, 0xffd070, 0xff6a1e],
    spd: [4.5, 13], ySpread: 0.9, yBias: 0.35, zBias: 0.4, jit: 0.06,
    grav: [-19, -12], drag: [5, 9], ttl: [0.10, 0.22],
    size: [0.10, 0.18], grow: 0.25, alpha: 1.0, curve: 0.6, fadeIn: 0,
  },
  // Zombie deaths. DELIBERATELY dark and desaturated: bright red is the barrel
  // channel and it carries gameplay meaning, so a kill must never flash in it.
  blood: {
    n: 10, mode: OVER, ramp: [0x6e332c, 0x45211d, 0x241412],
    spd: [1.6, 5.2], ySpread: 0.7, yBias: 0.45, zBias: 0.2, jit: 0.16,
    grav: [-12, -9], drag: [3, 4.5], ttl: [0.30, 0.58],
    size: [0.16, 0.28], grow: 1.6, alpha: 0.88, curve: 1.4, fadeIn: 0,
  },
  // Barrel fireball. The ramp ends on smoke-black, which under additive blending
  // is how the flame goes out rather than pops out.
  fire: {
    n: 14, mode: ADD, ramp: [0xffe070, 0xff5a1e, 0x3a2a26],
    spd: [2.5, 8], ySpread: 0.8, yBias: 0.5, zBias: 0, jit: 0.24,
    grav: [2.0, 5.0], drag: [2.5, 3.6], ttl: [0.35, 0.8],
    size: [0.30, 0.58], grow: 2.0, alpha: 1.0, curve: 0.8, fadeIn: 0,
  },
  // High drag is the whole look: they lurch outward, stall, then just hang.
  smoke: {
    n: 6, mode: OVER, ramp: [0x6e6660, 0x857c72, 0x9c9286],
    spd: [0.8, 3.2], ySpread: 0.5, yBias: 0.9, zBias: 0, jit: 0.30,
    grav: [0.6, 1.6], drag: [4, 6], ttl: [0.9, 1.7],
    size: [0.45, 0.85], grow: 2.6, alpha: 0.34, curve: 1.5, fadeIn: 0.16,
  },
  // Bubble shatter: cyan, and the only kind that shrinks to nothing.
  shard: {
    n: 18, mode: ADD, ramp: [0xdffaff, 0x7fe8ff, 0x2fa8d0],
    spd: [3, 9.5], ySpread: 1.0, yBias: 0.3, zBias: 0.15, jit: 0.12,
    grav: [-10, -7], drag: [1.0, 1.6], ttl: [0.35, 0.66],
    size: [0.20, 0.34], grow: 0.08, alpha: 1.0, curve: 1.0, fadeIn: 0,
  },
  // Boss footfall. A flat outward disc -- vertical dust reads as an explosion.
  dust: {
    n: 12, mode: OVER, ramp: [0xe2cda4, 0xc2a878, 0x9a8763],
    spd: [2.5, 6.5], ySpread: 0.25, yBias: 0.18, zBias: 0, jit: 0.35,
    grav: [-2.2, -1.0], drag: [4.5, 6.5], ttl: [0.5, 1.0],
    size: [0.40, 0.75], grow: 2.2, alpha: 0.5, curve: 1.4, fadeIn: 0.1,
  },

  // ---- added for the impact/death overhaul. APPENDED, never reordered: the
  // ids below are the flat index into KIND_SPEC, and inserting a kind in the
  // middle would silently repaint every particle already in flight.

  // Flesh, hit but not killed: a slow dark PUFF that hangs where the round
  // landed. It is the low-frequency half of a body hit -- the eye needs
  // something that persists for two or three frames to register "that one
  // connected" at 60u of distance.
  flesh: {
    n: 8, mode: OVER, ramp: [0x5a2a24, 0x3a1a16, 0x24120f],
    spd: [0.6, 2.6], ySpread: 0.5, yBias: 0.55, zBias: 0.35, jit: 0.18,
    grav: [-3.0, -1.2], drag: [5.5, 8], ttl: [0.22, 0.42],
    size: [0.26, 0.48], grow: 2.1, alpha: 0.60, curve: 1.3, fadeIn: 0,
  },
  // ...and the high-frequency half: a fast, tight spray thrown BACK along the
  // bullet's path. Fired through burstDir so it leaves the wound in the
  // direction the round came from, which is what sells the hit as directional.
  gore: {
    n: 7, mode: OVER, ramp: [0x7e2f26, 0x4a1c18, 0x2a1210],
    spd: [3.0, 8.0], ySpread: 0.45, yBias: 0.3, zBias: 0.6, jit: 0.05,
    grav: [-16, -11], drag: [3.5, 5.5], ttl: [0.14, 0.30],
    size: [0.08, 0.16], grow: 0.7, alpha: 0.95, curve: 0.7, fadeIn: 0,
  },
  // Metal. Faster, whiter and far shorter-lived than `spark`, which is the
  // generic one: a ricochet has to read as a hard surface REFUSING the round,
  // so it is all initial velocity and almost no life.
  rico: {
    n: 6, mode: ADD, ramp: [0xffffff, 0xffc65a, 0xff5a14],
    spd: [7, 18], ySpread: 0.85, yBias: 0.4, zBias: 0.7, jit: 0.04,
    grav: [-24, -15], drag: [2.5, 4.5], ttl: [0.10, 0.26],
    size: [0.06, 0.12], grow: 0.2, alpha: 1.0, curve: 0.45, fadeIn: 0,
  },
  // The bubble is glass, not metal: tiny slow motes that twinkle out rather
  // than a spray. `curve` near 0 is what makes them wink instead of fade.
  glint: {
    n: 8, mode: ADD, ramp: [0xffffff, 0xa8f0ff, 0x3fbfe6],
    spd: [1.2, 4.5], ySpread: 1.0, yBias: 0.25, zBias: 0.2, jit: 0.20,
    grav: [-5, -2], drag: [1.6, 2.6], ttl: [0.28, 0.60],
    size: [0.05, 0.11], grow: 0.35, alpha: 1.0, curve: 0.35, fadeIn: 0,
  },
  // Bloater. The ONLY saturated green in the scene, so the pop cannot be
  // confused with a barrel (red) or a bubble (cyan) even at the horizon.
  toxic: {
    n: 16, mode: ADD, ramp: [0xdcff9a, 0x74e02a, 0x1c4a12],
    spd: [3, 11], ySpread: 0.8, yBias: 0.5, zBias: 0, jit: 0.26,
    grav: [1.2, 3.5], drag: [2.2, 3.4], ttl: [0.4, 0.9],
    size: [0.30, 0.62], grow: 2.2, alpha: 1.0, curve: 0.8, fadeIn: 0,
  },
  // The wet half of the same event, and the spitter's projectile splash.
  // Alpha-blended so it darkens the road instead of lighting it.
  bile: {
    n: 10, mode: OVER, ramp: [0x8fb03a, 0x50701c, 0x2a3c10],
    spd: [2, 7], ySpread: 0.7, yBias: 0.5, zBias: 0.25, jit: 0.16,
    grav: [-13, -9], drag: [2.5, 4], ttl: [0.30, 0.70],
    size: [0.12, 0.26], grow: 1.3, alpha: 0.90, curve: 1.2, fadeIn: 0,
  },
  // Long-lived orange motes that outlive the fireball. An explosion whose every
  // component dies on the same frame reads as a video cut; embers are the tail
  // that makes it read as an event with a decay.
  ember: {
    n: 10, mode: ADD, ramp: [0xffb04a, 0xff5a1e, 0x502018],
    spd: [1.5, 6], ySpread: 0.9, yBias: 0.6, zBias: 0, jit: 0.3,
    grav: [-3.5, 0.6], drag: [1.2, 2.2], ttl: [0.8, 1.8],
    size: [0.06, 0.14], grow: 0.5, alpha: 1.0, curve: 0.5, fadeIn: 0,
  },
  // The slow black column a barrel leaves behind. `smoke` is the fast puff that
  // belongs to the blast itself; this is the part still there a second later.
  plume: {
    n: 8, mode: OVER, ramp: [0x40382f, 0x6b6259, 0x9c9286],
    spd: [0.6, 2.6], ySpread: 0.5, yBias: 1.0, zBias: 0, jit: 0.35,
    grav: [0.5, 1.5], drag: [3.5, 5.5], ttl: [1.6, 3.0],
    size: [0.55, 1.05], grow: 3.0, alpha: 0.30, curve: 1.6, fadeIn: 0.25,
  },
  // Muzzle smoke, one particle at a time. Tiny alpha on purpose: at 3 shots/s
  // across 14 shooters even 0.2 alpha accumulates into a haze bank, and the
  // whole point is a wisp you notice only between shots.
  wisp: {
    n: 1, mode: OVER, ramp: [0xbdb2a4, 0xa79d92, 0x938b81],
    spd: [0.3, 1.3], ySpread: 0.4, yBias: 1.0, zBias: 0.15, jit: 0.05,
    grav: [0.5, 1.4], drag: [3.5, 5.5], ttl: [0.35, 0.75],
    size: [0.10, 0.22], grow: 3.2, alpha: 0.18, curve: 1.6, fadeIn: 0.10,
  },
}

// DERIVED, not hand-written. The previous three parallel literals were one
// copy-paste away from a kind whose id pointed at another kind's colour ramp --
// a bug with no error and no crash, just wrong-coloured blood. Object key order
// is insertion order, so appending a recipe above is the whole edit.
const KIND_NAMES = Object.keys(KINDS)
const KIND_SPEC = KIND_NAMES.map((k) => KINDS[k])
const KIND_ID = {}
for (let i = 0; i < KIND_NAMES.length; i++) KIND_ID[KIND_NAMES[i]] = i

/** Valid `burst` kinds, for debug menus. */
export const PKIND = Object.freeze(KIND_NAMES.slice())

// Module-scope scratch. Never allocated inside a frame.
const _col = new THREE.Color()

/**
 * `size * aSize` replaces the single global point size, `vMode` carries the
 * blend selector to the fragment stage, and the sprite shape comes from
 * gl_PointCoord rather than a texture -- a 4096-point cloud does not need a
 * sampler to draw a soft dot.
 *
 * The fog chunk is rewritten because the stock one mixes toward fogColor, which
 * on an ADDITIVE particle means a distant spark adds sand-coloured light instead
 * of fading out. `fogColor * vMode` fogs the alpha-blended kinds correctly and
 * fades the additive ones toward black, which is what "further away" means when
 * you are adding light.
 */
function patchParticleShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      'uniform float size;',
      'uniform float size;\nattribute float aSize;\nattribute float aMode;\nvarying float vMode;'
    )
    .replace(
      'gl_PointSize = size;',
      'vMode = aMode;\n\tgl_PointSize = size * aSize;'
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      'uniform float opacity;',
      'uniform float opacity;\nvarying float vMode;'
    )
    .replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n\tfloat pd = length( gl_PointCoord - vec2( 0.5 ) );\n\tdiffuseColor.a *= smoothstep( 0.5, 0.16, pd );'
    )
    .replace(
      '#include <fog_fragment>',
      [
        '#ifdef USE_FOG',
        '  #ifdef FOG_EXP2',
        '    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
        '  #else',
        '    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
        '  #endif',
        '  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * vMode, fogFactor );',
        '#endif',
      ].join('\n')
    )
    // Runs after <premultiplied_alpha_fragment> has done rgb *= a, so additive
    // particles keep their premultiplied colour and drop their destination
    // weight to zero. This one line is the whole mixed-blending trick.
    .replace(
      '#include <premultiplied_alpha_fragment>',
      '#include <premultiplied_alpha_fragment>\n\tgl_FragColor.a *= vMode;'
    )
}

function cacheKey() {
  // Stable, or three recompiles the program on every material touch.
  return 'aov-particles'
}

export function createParticles(scene) {
  const cap = CFG.pool.particles
  const rng = new Rng(0x51ed270b)

  // --- GPU-visible state (the position attribute IS the position store) ---
  const posAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3)
  const colAttr = new THREE.BufferAttribute(new Float32Array(cap * 4), 4)
  const sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1)
  const modeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1)
  posAttr.setUsage(THREE.DynamicDrawUsage)
  colAttr.setUsage(THREE.DynamicDrawUsage)
  sizeAttr.setUsage(THREE.DynamicDrawUsage)
  modeAttr.setUsage(THREE.DynamicDrawUsage)

  const pos = posAttr.array
  const col = colAttr.array
  const siz = sizeAttr.array
  const mod = modeAttr.array

  // --- CPU-only state ---
  const vx = new Float32Array(cap)
  const vy = new Float32Array(cap)
  const vz = new Float32Array(cap)
  const grav = new Float32Array(cap)
  const drag = new Float32Array(cap)
  const age = new Float32Array(cap)
  const invTtl = new Float32Array(cap)
  const sz0 = new Float32Array(cap)
  const sz1 = new Float32Array(cap)
  const alpha0 = new Float32Array(cap)
  const tint = new Float32Array(cap)
  const kindOf = new Uint8Array(cap)

  // Per-kind data the hot loop needs, flattened out of the spec objects so the
  // update never touches a polymorphic property.
  const nKinds = KIND_SPEC.length
  const ramps = new Float32Array(nKinds * 9)
  const curves = new Float32Array(nKinds)
  const fadeRates = new Float32Array(nKinds)
  for (let k = 0; k < nKinds; k++) {
    const spec = KIND_SPEC[k]
    for (let s = 0; s < 3; s++) {
      _col.setHex(spec.ramp[s], THREE.SRGBColorSpace)
      const o = k * 9 + s * 3
      ramps[o] = _col.r
      ramps[o + 1] = _col.g
      ramps[o + 2] = _col.b
    }
    curves[k] = spec.curve
    // A huge rate is "no fade-in", which keeps the branch out of the loop.
    fadeRates[k] = spec.fadeIn > 0 ? 1 / spec.fadeIn : 1e6
  }

  let live = 0

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', posAttr)
  geo.setAttribute('color', colAttr)
  geo.setAttribute('aSize', sizeAttr)
  geo.setAttribute('aMode', modeAttr)
  geo.setDrawRange(0, 0)

  const mat = new THREE.PointsMaterial({
    size: 1,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // The two halves of the mixed-blending trick. Without premultipliedAlpha
    // three uses SRC_ALPHA and the additive kinds silently become alpha-blended.
    premultipliedAlpha: true,
    blending: THREE.NormalBlending,
  })
  mat.onBeforeCompile = patchParticleShader
  mat.customProgramCacheKey = cacheKey

  const points = new THREE.Points(geo, mat)
  // three culls Points against the geometry bounding sphere, which is computed
  // once from whatever happened to be in the buffer and never again -- so the
  // whole cloud vanishes the moment the camera pans. Same failure as an
  // InstancedMesh, same fix.
  points.frustumCulled = false
  points.renderOrder = 20
  scene.add(points)

  // One hoisted range object per attribute: three CLEARS updateRanges after it
  // uploads, and addUpdateRange() would push a fresh {start,count} literal every
  // frame -- an allocation in the loop that cares most.
  const rPos = { start: 0, count: 0 }
  const rCol = { start: 0, count: 0 }
  const rSiz = { start: 0, count: 0 }
  const rMod = { start: 0, count: 0 }

  function upload(attr, range, count) {
    range.start = 0
    range.count = count
    const list = attr.updateRanges
    list.length = 0
    list.push(range)
    attr.needsUpdate = true
  }

  /** Swap-remove: copy the last live particle over slot i. */
  function move(dst, src) {
    if (dst === src) return
    vx[dst] = vx[src]; vy[dst] = vy[src]; vz[dst] = vz[src]
    grav[dst] = grav[src]; drag[dst] = drag[src]
    age[dst] = age[src]; invTtl[dst] = invTtl[src]
    sz0[dst] = sz0[src]; sz1[dst] = sz1[src]
    alpha0[dst] = alpha0[src]; tint[dst] = tint[src]
    kindOf[dst] = kindOf[src]
    siz[dst] = siz[src]; mod[dst] = mod[src]
    const d3 = dst * 3, s3 = src * 3
    pos[d3] = pos[s3]; pos[d3 + 1] = pos[s3 + 1]; pos[d3 + 2] = pos[s3 + 2]
    const d4 = dst * 4, s4 = src * 4
    col[d4] = col[s4]; col[d4 + 1] = col[s4 + 1]
    col[d4 + 2] = col[s4 + 2]; col[d4 + 3] = col[s4 + 3]
  }

  /**
   * Spawn one burst. Spawns EXACTLY at (x, y, z) -- callers pass the torso
   * height for blood and fire; nothing is lifted for you, because a fudge here
   * would silently misplace every future emitter too.
   * @param {string} kind one of PKIND
   * @param {number} count 0 uses the kind's own default
   */
  function burst(kind, x, y, z, count) {
    emit(kind, x, y, z, count, 0, 0, 0)
  }

  /**
   * A burst with a BIAS VELOCITY added to every particle.
   *
   * Impacts are the reason this exists: an isotropic puff says "something
   * happened here", a spray thrown back along the bullet's path says "a round
   * went INTO that". Adding a constant rather than sampling a cone is
   * deliberate -- a cone needs an orthonormal basis per burst (nine multiplies
   * and a degenerate case when the axis is vertical) for a result the player
   * cannot distinguish from this, at 60u of distance, in 0.2 seconds.
   */
  function burstDir(kind, x, y, z, count, bx, by, bz) {
    emit(kind, x, y, z, count, bx, by, bz)
  }

  function emit(kind, x, y, z, count, bx, by, bz) {
    let id = KIND_ID[kind]
    if (id === undefined) id = 0
    const K = KIND_SPEC[id]
    const n = count > 0 ? count : K.n
    const r0 = id * 9

    for (let k = 0; k < n; k++) {
      // A full pool drops the newest rather than recycling the oldest: stealing
      // slots would gut the explosion that is still mid-flight.
      if (live >= cap) return
      const i = live++

      const a = rng.next() * TAU
      const cu = rng.range(-1, 1)
      const su = Math.sqrt(1 - cu * cu)
      const sp = rng.range(K.spd[0], K.spd[1])
      vx[i] = Math.cos(a) * su * sp + bx
      vy[i] = (cu * K.ySpread + K.yBias) * sp + by
      vz[i] = (Math.sin(a) * su + K.zBias) * sp + bz

      grav[i] = rng.range(K.grav[0], K.grav[1])
      drag[i] = rng.range(K.drag[0], K.drag[1])
      age[i] = 0
      invTtl[i] = 1 / rng.range(K.ttl[0], K.ttl[1])
      const s0 = rng.range(K.size[0], K.size[1])
      sz0[i] = s0
      sz1[i] = s0 * K.grow
      alpha0[i] = K.alpha
      const tn = rng.range(0.86, 1.14)
      tint[i] = tn
      kindOf[i] = id

      const j = K.jit
      const i3 = i * 3
      pos[i3] = x + rng.range(-j, j)
      pos[i3 + 1] = y + rng.range(-j, j)
      pos[i3 + 2] = z + rng.range(-j, j)

      // Seeded with stop 0 so a burst emitted after this frame's sync() is
      // never drawn as a black dot for one frame.
      const i4 = i * 4
      col[i4] = ramps[r0] * tn
      col[i4 + 1] = ramps[r0 + 1] * tn
      col[i4 + 2] = ramps[r0 + 2] * tn
      col[i4 + 3] = K.fadeIn > 0 ? 0 : K.alpha
      siz[i] = s0
      mod[i] = K.mode
    }
  }

  /**
   * One flat pass over the live prefix. `camera` is accepted for interface
   * symmetry and deliberately unused: point sprites are screen-aligned by
   * construction, so there is nothing here to billboard.
   */
  function sync(dt, camera) {
    let i = 0
    while (i < live) {
      const t = age[i] + dt
      const u = t * invTtl[i]
      if (u >= 1) {
        live--
        move(i, live)
        continue
      }
      age[i] = t

      // Exponential-ish drag as a single reciprocal: stable at any dt, and
      // unlike v -= v*drag*dt it cannot overshoot into a sign flip.
      const k = 1 / (1 + drag[i] * dt)
      let ux = vx[i] * k
      let uy = (vy[i] + grav[i] * dt) * k
      let uz = vz[i] * k

      const i3 = i * 3
      let px = pos[i3] + ux * dt
      let py = pos[i3 + 1] + uy * dt
      let pz = pos[i3 + 2] + uz * dt

      if (py < GROUND_Y) {
        py = GROUND_Y
        if (uy < 0) {
          uy *= -0.18
          ux *= 0.55
          uz *= 0.55
        }
      }

      vx[i] = ux; vy[i] = uy; vz[i] = uz
      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz

      const kd = kindOf[i]
      const r0 = kd * 9
      let cr, cg, cb
      if (u < 0.5) {
        const f = u * 2
        cr = ramps[r0] + (ramps[r0 + 3] - ramps[r0]) * f
        cg = ramps[r0 + 1] + (ramps[r0 + 4] - ramps[r0 + 1]) * f
        cb = ramps[r0 + 2] + (ramps[r0 + 5] - ramps[r0 + 2]) * f
      } else {
        const f = u * 2 - 1
        cr = ramps[r0 + 3] + (ramps[r0 + 6] - ramps[r0 + 3]) * f
        cg = ramps[r0 + 4] + (ramps[r0 + 7] - ramps[r0 + 4]) * f
        cb = ramps[r0 + 5] + (ramps[r0 + 8] - ramps[r0 + 5]) * f
      }

      const rem = 1 - u
      const c = curves[kd]
      let fi = t * fadeRates[kd]
      if (fi > 1) fi = 1
      const a = alpha0[i] * fi * rem * (c + (1 - c) * rem)
      const tn = tint[i]

      const i4 = i * 4
      col[i4] = cr * tn
      col[i4 + 1] = cg * tn
      col[i4 + 2] = cb * tn
      col[i4 + 3] = a
      siz[i] = sz0[i] + (sz1[i] - sz0[i]) * u

      i++
    }

    geo.setDrawRange(0, live)
    if (live === 0) return
    upload(posAttr, rPos, live * 3)
    upload(colAttr, rCol, live * 4)
    upload(sizeAttr, rSiz, live)
    upload(modeAttr, rMod, live)
  }

  function reset() {
    live = 0
    geo.setDrawRange(0, 0)
  }

  function dispose() {
    scene.remove(points)
    geo.dispose()
    mat.dispose()
  }

  return { burst, burstDir, sync, reset, dispose }
}
