/**
 * Everything that leaves the barrel: tracers, muzzle flashes, and shell casings.
 *
 * "Firing looks like shit" was the verdict on the previous pass, and the cause
 * was that every tier fired the same pale streak at the same speed. A weapon
 * upgrade has to be visible in the FIRING, not just in the DPS readout, so the
 * whole module is driven off a per-tier LOOK profile keyed on WEAPONS[i].id:
 *
 *   pistol / smg  short bright darts, slow enough that you read individual rounds
 *   rifle         one long clean streak, fast
 *   shotgun       FIVE short fat pellets that visibly fan apart as they travel
 *   minigun       thin, very fast, very dense -- a river, not a burst
 *
 * Keying on `id` rather than on the tier index is deliberate: the roster is
 * growing from four tiers to five, and an index table would silently reassign
 * the shotgun's look to the rifle the day 'smg' is inserted at index 1.
 *
 * THE BLOOM IS FAKE, deliberately. Each tracer draws twice -- a hot thin core
 * and a dim wide twin behind it. A real EffectComposer/UnrealBloomPass costs a
 * full-res target plus ~5 blur passes (3-6ms on the phones this ships to), drags
 * manual output-colorspace handling in with it, and blows the additive reward
 * bubbles into white blobs. The twin-instance trick took ten minutes and reads
 * better in a flat-shaded scene.
 *
 * SHELL CASINGS live here rather than in debris.js because they are ejected by
 * spawnMuzzle(), which already knows the tier. Wiring them anywhere else would
 * mean a second bus subscription that can silently fall out of sync with the
 * flash. They are the cheapest "this gun is real" signal in the whole build: 24
 * lit tris, one draw call, and they bounce off the road.
 *
 * Read-only over `w`. Nothing here can change what the sim already resolved --
 * in particular the decimation below drops PIXELS, never damage.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { CFG } from '../config.js'
import { WEAPONS, TURRET, TURRET_TIER } from '../data/weapons.js'
import { Pool } from '../util/pool.js'
import { Rng } from '../util/rng.js'
import { clamp, damp, lerp } from '../util/math.js'

// --------------------------------------------------------------- frame scratch
// Hoisted to module scope: sync() runs 60x/s over ~300 instances, and a single
// `new Vector3()` in there is 18k allocations a second of pure GC pressure.
const _m4 = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
const _quat = new Quaternion()
const _roll = new Quaternion()
const _axis = new Vector3(0, 0, 1)
const _axisZ = new Vector3(0, 0, 1)
const _color = new Color()

const TAU = Math.PI * 2

// ------------------------------------------------------------------- constants
// These are LOOK, not balance, so they live here rather than in CFG -- nothing
// in tools/harness.mjs can be affected by any of them.
const CORE_SPAN = 3.4          // base streak length, world units, before the tier multiplier
const SPAN_FRAME_SAFETY = 1.15
const GLOW_LEN_MULT = 1.08
const MUZZLE_SIZE = 0.55

// Decimation guards FILL RATE, so the rate is counted in INSTANCES (a shotgun
// blast is five) and the stride drops whole SHOTS -- dropping individual pellets
// would eat the spread, which is the one thing that makes the shotgun a shotgun.
const DECIMATE_ON = 240        // instances/sec
const DECIMATE_OFF = 190       // hysteresis band, see sync()
const DECIMATE_STRIDE = 2
const DECIMATE_WIDTH = 1.30
const DECIMATE_GAIN = 1.18
const RATE_SMOOTH = 0.0015     // damp(): fraction of error left after 1s, ~0.15s tau

// Low-discrepancy steps for the per-flash roll and size. Better-spread angles
// than uniform noise for one add and a mod, and no visible repeat.
const GOLDEN = 0.6180339887498949
const SILVER = 0.4142135623730951

// 1.15s of life against the worst-case ejection rate (the pistol, 3 rounds/s x
// 14 visible shooters) is what keeps the brass under the cap. Longer-lived
// casings do not look better; they just starve the pool and start dropping the
// ones being ejected NOW, which is the only brass anyone is looking at.
const CASING_CAP = 72
const CASING_LIFE = 1.15
const CASING_SHRINK = 0.25     // seconds of shrink at the end, so nothing pops out
const CASING_GRAVITY = -19
const CASING_FLOOR = 0.035
const CASING_BOUNCE = 0.34
const CASING_FRICTION = 0.58
const CASING_SCALE = 0.030

/**
 * Per-tier look. `diverge*` is lateral drift per unit of FORWARD travel, which
 * is what makes a shotgun's pellets fan instead of running parallel; `speed` is
 * a multiplier on CFG.combat.tracerSpeed and it is the strongest single knob
 * here, because a streak can only read as "short" if it is slow enough that one
 * frame of travel does not exceed its own length (see the span clamp in sync).
 */
const LOOK = {
  pistol: {
    pellets: 1, divergeX: 0, divergeY: 0, span: 0.70, speed: 0.55, width: 1.00,
    coreK: 0.99, glowK: 0.26, glowW: 3.2,
    flashSize: 0.62, flashAspect: 1.00, flashGain: 3.0, flashLife: 1.15,
    smoke: 0.55, casing: 1.00, casingSize: 1.00,
    tracer: 0xffd479, muzzle: 0xffe9b0,
  },
  smg: {
    pellets: 1, divergeX: 0.005, divergeY: 0.002, span: 0.62, speed: 0.62, width: 0.86,
    coreK: 1.04, glowK: 0.24, glowW: 3.0,
    flashSize: 0.52, flashAspect: 1.05, flashGain: 2.8, flashLife: 0.95,
    smoke: 0.16, casing: 0.30, casingSize: 0.82,
    tracer: 0xffdc8e, muzzle: 0xfff0c0,
  },
  rifle: {
    pellets: 1, divergeX: 0, divergeY: 0, span: 2.00, speed: 1.25, width: 1.00,
    coreK: 1.21, glowK: 0.26, glowW: 3.5,
    flashSize: 0.72, flashAspect: 1.30, flashGain: 3.2, flashLife: 1.20,
    smoke: 0.35, casing: 0.60, casingSize: 1.00,
    tracer: 0xffe08a, muzzle: 0xfff0c0,
  },
  shotgun: {
    // FOUR visual pellets, not the roster's five. 14 visible shooters x 5 fat
    // slow pellets is 70 overlapping additive instances leaving a 2u-wide
    // muzzle cluster on the same frame, and the whole blast whites out into one
    // blob -- the exact opposite of the spread it exists to show. The sim still
    // fires five; this drops a PIXEL, never a pellet of damage.
    pellets: 4, divergeX: 0.055, divergeY: 0.016, span: 0.50, speed: 0.50, width: 0.90,
    coreK: 0.80, glowK: 0.20, glowW: 2.2,
    flashSize: 0.85, flashAspect: 1.75, flashGain: 3.0, flashLife: 1.55,
    smoke: 0.85, casing: 1.00, casingSize: 1.35,
    tracer: 0xffc46b, muzzle: 0xffdca0,
  },
  minigun: {
    pellets: 1, divergeX: 0.007, divergeY: 0.004, span: 0.90, speed: 1.50, width: 0.62,
    coreK: 1.16, glowK: 0.15, glowW: 3.6,
    flashSize: 0.44, flashAspect: 0.95, flashGain: 2.5, flashLife: 0.72,
    // A rotary gun ejects into a chute, not into the air, and at 12 rounds/s a
    // second soldier's worth of brass would be a solid wall of instances.
    smoke: 0, casing: 0, casingSize: 0,
    tracer: 0xfff2c8, muzzle: 0xffffff,
  },
  turret: {
    // The mounted gun of TURRET mode. Hot and long: it is the one stream in
    // the scene that leaves at an angle, and it has to read as the player's
    // own line against the squad's parallel amber. Casings would eject into
    // the camera, so none.
    pellets: 1, divergeX: 0, divergeY: 0, span: 1.25, speed: 1.55, width: 1.05,
    coreK: 1.25, glowK: 0.34, glowW: 4.2,
    flashSize: 0.95, flashAspect: 1.20, flashGain: 3.2, flashLife: 0.85,
    smoke: 0.12, casing: 0, casingSize: 0,
    tracer: 0xff7a55, muzzle: 0xffc0a0,
  },
}
const LOOK_DEFAULT = LOOK.rifle

/**
 * Flatten the profile table against the live WEAPONS roster ONCE, plus one
 * extra row for the turret at TURRET_TIER. Doing this per spawn would mean
 * ~200 sRGB->linear conversions a second for six distinct answers, and would
 * put the WEAPONS table on the hot path. Any id the table does not know
 * resolves to the rifle profile rather than throwing, so adding a tier
 * degrades to "looks like a rifle" instead of a black screen.
 */
const N_TIER = WEAPONS.length + 1
const MAX_TIER_INDEX = N_TIER - 1
const P = []
const TRACER_RGB = new Float32Array(N_TIER * 3)
const MUZZLE_RGB = new Float32Array(N_TIER * 3)
for (let i = 0; i < N_TIER; i++) {
  const wep = i === TURRET_TIER ? TURRET : WEAPONS[i]
  const look = LOOK[wep.id] || LOOK_DEFAULT
  P.push(look)
  // The data table owns the hue when it declares one; the profile is the
  // fallback so a roster row without colours still fires something warm.
  _color.setHex(wep.tracerColor !== undefined ? wep.tracerColor : look.tracer, SRGBColorSpace)
  TRACER_RGB[i * 3] = _color.r
  TRACER_RGB[i * 3 + 1] = _color.g
  TRACER_RGB[i * 3 + 2] = _color.b
  _color.setHex(wep.muzzleColor !== undefined ? wep.muzzleColor : look.muzzle, SRGBColorSpace)
  MUZZLE_RGB[i * 3] = _color.r
  MUZZLE_RGB[i * 3 + 1] = _color.g
  MUZZLE_RGB[i * 3 + 2] = _color.b
}
// The roster owns tracerWidth / tracerLen / casings when it declares them; the
// LOOK profile only fills the gaps. Two tables both claiming the same number is
// how a tier ends up 1.35x longer than the balance pass intended and nobody can
// say which file to edit.
const TRACER_WIDTH = new Float32Array(N_TIER)
const SPAN_MULT = new Float32Array(N_TIER)
const CASING_P = new Float32Array(N_TIER)
for (let i = 0; i < N_TIER; i++) {
  const wep = i === TURRET_TIER ? TURRET : WEAPONS[i]
  const look = P[i]
  TRACER_WIDTH[i] = typeof wep.tracerWidth === 'number' && wep.tracerWidth > 0 ? wep.tracerWidth : 1
  SPAN_MULT[i] = typeof wep.tracerLen === 'number' && wep.tracerLen > 0 ? wep.tracerLen : look.span
  CASING_P[i] = wep.casings === false ? 0 : look.casing
}

function makeTracer() {
  return {
    x: 0, y: 0, z: 0, endZ: 0, travel: 0, headZ: 0, tailZ: 0,
    w: 0, span: 0, speed: 1, dx: 0, dy: 0,
    r: 1, g: 1, b: 1, coreK: 0.55, glowK: 0.75, glowW: 3,
  }
}

function makeFlash() {
  return { x: 0, y: 0, z: 0, life: 0, ttl: 1, roll: 0, sx: 0, sy: 0, r: 1, g: 1, b: 1, gain: 1 }
}

function makeCasing() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    ax: 0, ay: 1, az: 0, spin: 0, angle: 0, life: 0, scale: 1, tone: 1,
  }
}

/**
 * Two crossed quads, not a box.
 *
 * A single flat quad is edge-on to this camera (y=11.2 looking at y=0.5, a very
 * shallow pitch) and a 0.06u-wide tracer disappears entirely. A box is 12
 * triangles instead of 4 AND additively double-adds wherever its own faces
 * overlap, so the streak's brightness would depend on the viewing angle. A cross
 * with side:DoubleSide is always exactly two quads deep, everywhere, forever.
 */
function buildStreakGeometry() {
  const p = new Float32Array([
    // horizontal quad, long axis +Z
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5,
    -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
    // vertical quad
    0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5,
    0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5,
  ])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(p, 3))
  return g
}

/**
 * CHUNKY flash sprite, baked once at boot.
 *
 * The previous sprite was a soft radial dot with two symmetric spikes, which is
 * why a barrage looked rubber-stamped: rolling a radially symmetric blob changes
 * nothing you can see. This one is built from HARD-EDGED irregular petals at
 * irregular angles, so the per-flash roll actually produces a different shape
 * every time, and the silhouette has corners instead of a gradient.
 */
function bakeFlashTexture() {
  const S = 96
  const H = S / 2
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  const rng = new Rng(0x2f9a41b7)

  g.globalCompositeOperation = 'lighter'

  // Broad halo first: it is what keeps the petals from reading as a paper cutout.
  const halo = g.createRadialGradient(H, H, 0, H, H, H)
  halo.addColorStop(0.00, 'rgba(255,244,210,0.60)')
  halo.addColorStop(0.30, 'rgba(255,214,140,0.26)')
  halo.addColorStop(1.00, 'rgba(255,180,80,0)')
  g.fillStyle = halo
  g.fillRect(0, 0, S, S)

  // Seven petals, never an even number: even counts read as a symmetric star and
  // symmetry is exactly what makes a repeated sprite look stamped.
  const PETALS = 7
  g.save()
  g.translate(H, H)
  for (let i = 0; i < PETALS; i++) {
    const a = (i / PETALS) * TAU + rng.range(-0.22, 0.22)
    const len = H * rng.range(0.52, 0.98)
    const halfW = rng.range(0.10, 0.26)
    const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len)
    grad.addColorStop(0.0, 'rgba(255,255,255,0.95)')
    grad.addColorStop(0.45, 'rgba(255,226,150,0.55)')
    grad.addColorStop(1.0, 'rgba(255,170,60,0)')
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(Math.cos(a - halfW) * H * 0.20, Math.sin(a - halfW) * H * 0.20)
    g.lineTo(Math.cos(a) * len, Math.sin(a) * len)
    g.lineTo(Math.cos(a + halfW) * H * 0.20, Math.sin(a + halfW) * H * 0.20)
    g.closePath()
    g.fill()
  }
  g.restore()

  // Hot core LAST so nothing dilutes it. This blown-out centre is the entire
  // reason the scene needs no PointLight: the eye reads a clipped highlight as a
  // light source and never asks what the sand is doing.
  const core = g.createRadialGradient(H, H, 0, H, H, H * 0.30)
  core.addColorStop(0.00, 'rgba(255,255,255,1)')
  core.addColorStop(0.55, 'rgba(255,250,225,0.85)')
  core.addColorStop(1.00, 'rgba(255,230,170,0)')
  g.fillStyle = core
  g.fillRect(0, 0, S, S)

  const tex = new CanvasTexture(c)
  // Multiplied into emitted colour, so it is a colour map: leaving it linear
  // makes the falloff read far tighter than the gradient that was authored.
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** Additive, unlit, unfogged. See the fog note inside. */
function makeAdditiveMaterial(map) {
  return new MeshBasicMaterial({
    map: map || null,
    color: 0xffffff,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    // FogExp2 mixes the fragment TOWARD the fog colour, which on an additive
    // pass means far tracers stop being light and start adding beige haze to
    // the haze. Silent, and it eats the far half of the corridor.
    fog: false,
    // If tone mapping is ever switched on in the renderer it would crush exactly
    // the clipped highlight the fake bloom is built out of.
    toneMapped: false,
    side: DoubleSide,
  })
}

/** Allocate instanceColor up front: assigning it post-compile forces a program rebuild. */
function makeInstanced(geo, mat, capacity, order) {
  const m = new InstancedMesh(geo, mat, capacity)
  m.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  m.instanceMatrix.setUsage(DynamicDrawUsage)
  m.instanceColor.setUsage(DynamicDrawUsage)
  // three culls an InstancedMesh against the geometry bounding sphere sitting at
  // the mesh origin, so the entire stream pops out of existence the moment the
  // camera leans. No warning, no error.
  m.frustumCulled = false
  m.count = 0
  m.renderOrder = order
  return m
}

/**
 * @param {object} scene
 * @param {{particles?: object}} [deps] optional; supplying `particles` enables the
 *   muzzle-smoke wisp on the low-fire-rate tiers. Absent, everything else works.
 */
export function createTracers(scene, deps) {
  let particles = (deps && deps.particles) || null

  const tracers = new Pool(CFG.pool.tracers, makeTracer)
  const flashes = new Pool(CFG.pool.muzzle, makeFlash)
  const casings = new Pool(CASING_CAP, makeCasing)
  const rng = new Rng(0x7b13c05f)

  const streakGeo = buildStreakGeometry()
  const flashGeo = new PlaneGeometry(1, 1)
  const flashTex = bakeFlashTexture()
  // Length baked into the geometry so a casing's instance scale stays one
  // scalar, which is what lets the shrink-out at end of life be a single lerp.
  const casingGeo = new CylinderGeometry(0.5, 0.42, 2.6, 6, 1)

  const glowMat = makeAdditiveMaterial(null)
  const coreMat = makeAdditiveMaterial(null)
  const flashMat = makeAdditiveMaterial(flashTex)
  // Lit, not additive: brass has to read as a solid object catching the key
  // light, otherwise it is just another spark and the whole point is lost.
  const casingMat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x1a1207 })

  const glowMesh = makeInstanced(streakGeo, glowMat, tracers.capacity, 10)
  const coreMesh = makeInstanced(streakGeo, coreMat, tracers.capacity, 11)
  const flashMesh = makeInstanced(flashGeo, flashMat, flashes.capacity, 12)
  const casingMesh = makeInstanced(casingGeo, casingMat, casings.capacity, 1)
  scene.add(glowMesh)
  scene.add(coreMesh)
  scene.add(flashMesh)
  scene.add(casingMesh)

  // Billboard orientation, kept across frames so a missing camera argument
  // degrades to "flashes face where they last faced" instead of throwing.
  const camQ = new Quaternion()

  // Squad-derived values are sampled in sync() and consumed by the spawn calls,
  // which arrive from the bus with no world reference of their own.
  let spawnWidth = CFG.weapons.tracerThin
  let spawnTier = CFG.weapons.startTier
  let scroll = 0

  let instThisFrame = 0
  let instRate = 0
  let shotSeq = 0
  let decimating = false
  let widthBoost = 1
  let gainBoost = 1
  let rollSeq = 0
  let sizeSeq = 0
  let smokeSeq = 0

  function sync(w, dt, camera) {
    const wep = CFG.weapons
    // THICKEN, don't multiply. Instance count is what costs fill rate at this
    // overdraw, so a 40-soldier squad gets a fatter river, not 40 more streaks.
    spawnWidth = lerp(wep.tracerThin, wep.tracerThick, clamp(w.count / wep.tracerThinCount, 0, 1))
    // The squad's tier only: the turret names its own look on every event.
    spawnTier = clamp(w.tier | 0, 0, WEAPONS.length - 1)
    scroll = w.scroll

    // Raw instances-per-frame is violently spiky (fire timers cluster on the
    // phase stagger), so decimation is driven off a smoothed rate. The
    // hysteresis band matters more than the threshold: a stride flipping on and
    // off is far more visible than the missing rounds ever are.
    instRate = damp(instRate, dt > 0 ? instThisFrame / dt : 0, RATE_SMOOTH, dt)
    instThisFrame = 0
    if (decimating) {
      if (instRate < DECIMATE_OFF) decimating = false
    } else if (instRate > DECIMATE_ON) {
      decimating = true
    }
    widthBoost = decimating ? DECIMATE_WIDTH : 1
    gainBoost = decimating ? DECIMATE_GAIN : 1

    const baseSpeed = CFG.combat.tracerSpeed
    const items = tracers.items

    // Pass 1: advance and reap. Backwards, because release() swap-removes.
    for (let i = tracers.size - 1; i >= 0; i--) {
      const tr = items[i]
      const speed = baseSpeed * tr.speed
      tr.travel += speed * dt
      // A streak shorter than one frame of travel renders as a dashed line, so
      // its length has a floor that is a function of dt, not a constant. This is
      // per tracer because the tiers no longer share a speed.
      const minSpan = speed * dt * SPAN_FRAME_SAFETY
      const span = tr.span > minSpan ? tr.span : minSpan
      const head = tr.z - tr.travel
      const tail = head + span
      tr.headZ = head < tr.endZ ? tr.endZ : head
      tr.tailZ = tail > tr.z ? tr.z : tail
      // `travel > 0`: a tracer spawned on a frame that then reports dt = 0 has
      // not moved yet and its clamped span is legitimately zero. Without the
      // guard the whole barrage of that frame is reaped before it ever draws.
      if (tr.travel > 0 && tr.tailZ - tr.headZ <= 0.001) tracers.release(i)
    }

    // Pass 2: full rebuild over [0, size). Writing matrices in pass 1 would leave
    // a stale matrix at every index a swap-remove backfilled -- a one-frame ghost
    // streak, which is exactly the flicker bug the pool docs warn about.
    const cc = coreMesh.instanceColor.array
    const gc = glowMesh.instanceColor.array
    for (let i = 0; i < tracers.size; i++) {
      const tr = items[i]
      const len = tr.tailZ - tr.headZ
      const cz = (tr.headZ + tr.tailZ) * 0.5
      const minSpan = baseSpeed * tr.speed * dt * SPAN_FRAME_SAFETY
      const span = tr.span > minSpan ? tr.span : minSpan
      // Streaks are born short (emerging from the muzzle) and die short
      // (retracting into the impact). Fading with that length turns both ends
      // into a taper instead of a pop, which at 0.3s of life is all the eye gets.
      const f = len < span ? len / span : 1
      const wd = tr.w * widthBoost
      // Divergence is applied at the streak's CENTRE, so a fanning shotgun
      // pellet stays a straight segment while the group opens up.
      const flown = tr.z - cz
      const px = tr.x + tr.dx * flown
      const py = tr.y + tr.dy * flown

      _m4.makeScale(wd, wd, len)
      _m4.setPosition(px, py, cz)
      coreMesh.setMatrixAt(i, _m4)

      const gw = wd * tr.glowW
      _m4.makeScale(gw, gw, len * GLOW_LEN_MULT)
      _m4.setPosition(px, py, cz)
      glowMesh.setMatrixAt(i, _m4)

      const ci = i * 3
      const core = f * gainBoost * tr.coreK
      cc[ci] = tr.r * core
      cc[ci + 1] = tr.g * core
      cc[ci + 2] = tr.b * core
      const glow = f * gainBoost * tr.glowK
      gc[ci] = tr.r * glow
      gc[ci + 1] = tr.g * glow
      gc[ci + 2] = tr.b * glow
    }

    // ---- muzzle flashes
    if (camera && camera.isCamera) camQ.copy(camera.quaternion)
    const fitems = flashes.items
    for (let i = flashes.size - 1; i >= 0; i--) {
      fitems[i].life -= dt
      if (fitems[i].life <= 0) flashes.release(i)
    }
    const fc = flashMesh.instanceColor.array
    for (let i = 0; i < flashes.size; i++) {
      const fl = fitems[i]
      const u = 1 - clamp(fl.life / fl.ttl, 0, 1)   // 0 at birth, 1 at death
      const e = 0.80 + 0.55 * u                     // expand while fading: a puff, not a shrink
      _roll.setFromAxisAngle(_axisZ, fl.roll)
      _quat.copy(camQ).multiply(_roll)
      _pos.set(fl.x, fl.y, fl.z)
      _scale.set(fl.sx * e, fl.sy * e, 1)
      _m4.compose(_pos, _quat, _scale)
      flashMesh.setMatrixAt(i, _m4)

      const k = 1 - u
      const b = fl.gain * k * k
      const ci = i * 3
      fc[ci] = fl.r * b
      fc[ci + 1] = fl.g * b
      fc[ci + 2] = fl.b * b
    }

    // ---- shell casings
    const kitems = casings.items
    for (let i = casings.size - 1; i >= 0; i--) {
      const cs = kitems[i]
      cs.life -= dt
      if (cs.life <= 0) { casings.release(i); continue }
      cs.vy += CASING_GRAVITY * dt
      cs.x += cs.vx * dt
      cs.y += cs.vy * dt
      // Everything on the ground belongs to the corridor, which is scrolling
      // toward the camera. A casing that ignored it would visibly swim upstream
      // against the road stripes it just landed on.
      cs.z += (cs.vz + scroll) * dt
      cs.angle += cs.spin * dt
      if (cs.y < CASING_FLOOR) {
        cs.y = CASING_FLOOR
        if (cs.vy < 0) {
          cs.vy *= -CASING_BOUNCE
          cs.vx *= CASING_FRICTION
          cs.vz *= CASING_FRICTION
          cs.spin *= CASING_FRICTION
        }
      }
    }
    const kc = casingMesh.instanceColor.array
    for (let i = 0; i < casings.size; i++) {
      const cs = kitems[i]
      // Shrink out rather than fade: the material is opaque and lit, so an alpha
      // fade would mean a second transparent material and a second draw call.
      const s = cs.scale * clamp(cs.life / CASING_SHRINK, 0, 1)
      _axis.set(cs.ax, cs.ay, cs.az)
      _quat.setFromAxisAngle(_axis, cs.angle)
      _pos.set(cs.x, cs.y, cs.z)
      _scale.set(s, s, s)
      _m4.compose(_pos, _quat, _scale)
      casingMesh.setMatrixAt(i, _m4)
      const ci = i * 3
      kc[ci] = 0.86 * cs.tone
      kc[ci + 1] = 0.66 * cs.tone
      kc[ci + 2] = 0.22 * cs.tone
    }

    coreMesh.count = tracers.size
    glowMesh.count = tracers.size
    flashMesh.count = flashes.size
    casingMesh.count = casings.size
    coreMesh.instanceMatrix.needsUpdate = true
    glowMesh.instanceMatrix.needsUpdate = true
    flashMesh.instanceMatrix.needsUpdate = true
    casingMesh.instanceMatrix.needsUpdate = true
    // Separate flags, on purpose. Riding the matrix flag freezes every tint at
    // its boot value while the geometry keeps moving: grey streaks, no error.
    coreMesh.instanceColor.needsUpdate = true
    glowMesh.instanceColor.needsUpdate = true
    flashMesh.instanceColor.needsUpdate = true
    casingMesh.instanceColor.needsUpdate = true
  }

  /**
   * One round leaving one muzzle. May produce SEVERAL instances -- a shotgun
   * shell is five diverging pellets, and one line for a shotgun was the single
   * most-cited reason the firing read as thin.
   *
   * @param {number} endZ the z the shot resolved against (w.lastHitZ)
   * @param {number} tier weapon tier at the moment of the shot (TURRET_TIER for the gun)
   * @param {number} [rake] lateral drift per unit of -z travel: 0 for every
   *   soldier, tan(yaw) for the turret. The streak stays a straight segment
   *   because divergence is applied at its centre (see sync).
   */
  function spawnTracer(x, y, z, endZ, tier, rake = 0) {
    shotSeq++
    // PURELY VISUAL. The sim already resolved this shot's damage; above ~200
    // instances/s the eye reads a stream and cannot count what is in it. A fixed
    // stride rather than a random draw, because random dropping makes the
    // stream's DENSITY flicker, which is precisely what you notice.
    if (decimating && shotSeq % DECIMATE_STRIDE !== 0) return
    if (endZ >= z) return

    const t = clamp(tier | 0, 0, MAX_TIER_INDEX)
    const look = P[t]
    const n = look.pellets
    const baseW = spawnWidth * TRACER_WIDTH[t] * look.width
    const half = (n - 1) * 0.5

    for (let p = 0; p < n; p++) {
      const tr = tracers.acquire()
      if (!tr) return
      instThisFrame++
      // Fan index in [-1, 1], jittered so the five pellets are never a neat comb.
      const fan = half > 0 ? (p - half) / half : 0
      tr.x = x
      tr.y = y
      tr.z = z
      // A shared end plane makes all five pellets die on the same frame, which
      // reads as a single line switching off. Ragged ends read as a pattern.
      tr.endZ = n > 1 ? Math.min(z - 0.05, endZ + rng.range(-0.7, 0.7)) : endZ
      tr.travel = 0
      tr.headZ = z
      tr.tailZ = z
      tr.speed = look.speed * (n > 1 ? rng.range(0.88, 1.12) : 1)
      tr.span = CORE_SPAN * SPAN_MULT[t] * (n > 1 ? rng.range(0.75, 1.25) : 1)
      tr.w = baseW * (n > 1 ? rng.range(0.8, 1.25) : 1)
      tr.dx = rake + fan * look.divergeX + rng.range(-1, 1) * look.divergeX * 0.35
      tr.dy = fan * look.divergeY + rng.range(-1, 1) * look.divergeY * 0.6
      tr.coreK = look.coreK
      tr.glowK = look.glowK
      tr.glowW = look.glowW
      tr.r = TRACER_RGB[t * 3]
      tr.g = TRACER_RGB[t * 3 + 1]
      tr.b = TRACER_RGB[t * 3 + 2]
    }
  }

  /**
   * Flash, wisp and brass for one round. Tier comes from the last sync() unless
   * the caller names one -- the turret does, since it is not the squad's weapon.
   */
  function spawnMuzzle(x, y, z, tier) {
    const t = tier === undefined ? spawnTier : clamp(tier | 0, 0, MAX_TIER_INDEX)
    const look = P[t]

    rollSeq = (rollSeq + GOLDEN) % 1
    sizeSeq = (sizeSeq + SILVER) % 1
    const size = MUZZLE_SIZE * look.flashSize * (0.82 + 0.36 * sizeSeq)
    spawnFlash(
      x, y, z,
      size * look.flashAspect, size,
      MUZZLE_RGB[t * 3], MUZZLE_RGB[t * 3 + 1], MUZZLE_RGB[t * 3 + 2],
      CFG.fx.muzzleLife * look.flashLife, look.flashGain, rollSeq * TAU,
    )

    // A wisp per shot at 2.5 rounds/s reads as a gun; a wisp per shot at 12
    // rounds/s is a fog bank sitting on the squad. The probability is part of
    // the tier's identity, not a global.
    if (particles && look.smoke > 0) {
      smokeSeq = (smokeSeq + GOLDEN) % 1
      if (smokeSeq < look.smoke) particles.burst('wisp', x, y + 0.05, z - 0.25, 1)
    }

    const pCasing = CASING_P[t]
    if (pCasing <= 0) return
    smokeSeq = (smokeSeq + SILVER) % 1
    if (pCasing < 1 && smokeSeq > pCasing) return
    const cs = casings.acquire()
    if (!cs) return
    cs.x = x + 0.06
    cs.y = y - 0.06
    cs.z = z + 0.12
    // Out to the right and BACK toward the camera: ejecting forward would put
    // the brass inside the corridor the soldier is shooting down, where it
    // crosses its own tracers.
    cs.vx = rng.range(1.9, 3.4)
    cs.vy = rng.range(2.2, 3.6)
    cs.vz = rng.range(1.0, 2.4)
    const ax = rng.range(-1, 1), ay = rng.range(-1, 1), az = rng.range(-1, 1)
    const inv = 1 / Math.max(0.001, Math.sqrt(ax * ax + ay * ay + az * az))
    cs.ax = ax * inv; cs.ay = ay * inv; cs.az = az * inv
    cs.spin = rng.range(14, 26) * rng.sign()
    cs.angle = rng.range(0, TAU)
    cs.life = CASING_LIFE
    cs.scale = CASING_SCALE * look.casingSize
    cs.tone = rng.range(0.82, 1.20)
  }

  /**
   * A one-off flash on the shared instanced quad. Impacts use this for the
   * "something metal was struck" pop, which is why it takes a colour and a size
   * rather than a tier -- the flash mesh is a general-purpose light stamp and
   * reusing it costs zero extra draw calls.
   */
  function spawnFlash(x, y, z, sx, sy, r, g, b, ttl, gain, roll) {
    const fl = flashes.acquire()
    // A full pool means every flash slot is already alive inside a ~60ms window.
    // The next one is not a thing anyone can see, and growing the pool only buys
    // more overdraw.
    if (!fl) return
    fl.x = x
    fl.y = y
    fl.z = z
    fl.ttl = ttl > 0 ? ttl : CFG.fx.muzzleLife
    fl.life = fl.ttl
    fl.roll = roll === undefined ? ((rollSeq = (rollSeq + GOLDEN) % 1) * TAU) : roll
    fl.sx = sx
    fl.sy = sy === undefined ? sx : sy
    fl.r = r
    fl.g = g
    fl.b = b
    fl.gain = gain === undefined ? 2.6 : gain
  }

  /** Late dependency injection, so main.js may construct in any order. */
  function attach(d) {
    if (d && d.particles) particles = d.particles
  }

  /** Instant restart: pools rewind, counts go to zero, nothing is reallocated. */
  function reset() {
    tracers.clear()
    flashes.clear()
    casings.clear()
    coreMesh.count = 0
    glowMesh.count = 0
    flashMesh.count = 0
    casingMesh.count = 0
    // Instance data below count is stale, but count = 0 means nothing reads it
    // and the next sync() rebuilds every live index before it raises count.
    instThisFrame = 0
    instRate = 0
    shotSeq = 0
    decimating = false
    widthBoost = 1
    gainBoost = 1
  }

  function dispose() {
    scene.remove(glowMesh)
    scene.remove(coreMesh)
    scene.remove(flashMesh)
    scene.remove(casingMesh)
    glowMesh.dispose()
    coreMesh.dispose()
    flashMesh.dispose()
    casingMesh.dispose()
    streakGeo.dispose()
    flashGeo.dispose()
    casingGeo.dispose()
    glowMat.dispose()
    coreMat.dispose()
    flashMat.dispose()
    casingMat.dispose()
    flashTex.dispose()
  }

  return { spawnTracer, spawnMuzzle, spawnFlash, attach, sync, reset, dispose }
}
