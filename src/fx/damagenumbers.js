/**
 * Floating damage numbers -- the one feedback channel the build was missing.
 *
 * A hit already produces sparks, a flash, a body flinch and a ring pulse, but
 * none of those answer "how much". That question is the whole reason the weapon
 * axis exists: without a number the player upgrades from an SMG to a shotgun and
 * has literally no evidence anything changed except that the barrel HP falls a
 * bit faster. This is the readout for the mode's central decision.
 *
 * AGGREGATION IS THE ENTIRE DESIGN PROBLEM. A minigun at 14 rounds/s across 14
 * visible shooters resolves damage against one walker every single step; one
 * number per HIT event is 60 numbers a second stacked on one body, which is
 * unreadable AND blows the glyph pool in three frames. So each target gets ONE
 * OPEN number that COUNTS UP for CFG.fx.damageAggregation seconds and re-pops on
 * every merge. The count-up is strictly better than the obvious
 * accumulate-then-emit: the player sees the first hit land immediately (zero
 * latency, which is what "responsive" means here) and then watches the total
 * climb, which is a far stronger read on DPS than a delayed lump sum.
 *
 * Targets are matched SPATIALLY, not by id: the HIT event carries no entity
 * reference (`{topic,x,y,z,a,b,c,kind}` is a fixed monomorphic shape and adding
 * a field to it would allocate). Matching on proximity is sound because
 * combat.js ledgers damage and emits at most one HIT per target per step, so
 * two open numbers can only collide if two bodies are within AGG_RADIUS of each
 * other -- at which point merging them is the correct read anyway.
 *
 * Glyphs come from the ONE baked atlas (view/atlas.js). Nothing here rasterises
 * text at runtime; a 512x512 canvas re-upload during a firefight is ~1MB in the
 * frame that can least afford it.
 */
import {
  Color, DynamicDrawUsage, FrontSide, InstancedBufferAttribute, InstancedMesh,
  Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, SRGBColorSpace, Vector3,
  Vector4,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'
import { Rng } from '../util/rng.js'

// --------------------------------------------------------------- frame scratch
const _m4 = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
const _quat = new Quaternion()
const _right = new Vector3(1, 0, 0)
const _uv = new Vector4()

const CODE_0 = 48

const MAX_DIGITS = 4           // 9999 caps it; a boss plate is the only thing that gets close
const N_NUMBERS = (CFG.pool.glyphs / MAX_DIGITS) | 0
const AGG_RADIUS = 1.10        // world units; a body is 0.3-0.55 wide, so this is ~2 bodies
const AGG_RADIUS_SQ = AGG_RADIUS * AGG_RADIUS

const LIFE = 0.72              // after the aggregation window closes
// A HARD ceiling on how long one number may keep counting up. Without it, a
// target under continuous fire re-arms its window on every single step and its
// number never closes, never rises and never leaves -- it just grows forever in
// place, which is the exact failure the aggregation was added to prevent.
const MAX_OPEN = 0.55
const RISE = 2.6               // u/s at birth, damped
const RISE_DAMP = 1.9
const DRIFT = 0.55             // lateral, so two numbers on adjacent bodies separate
const POP = 0.55               // extra scale at the instant of a merge
const POP_DECAY = 9.0
const SIZE = 0.46
const SIZE_PER_DIGIT = 0.86    // long numbers shrink slightly or a 4-digit hit is a wall
const ADVANCE = 0.62           // glyph pitch as a fraction of SIZE
const Z_LIFT = 0.35            // toward the camera, so the body it belongs to cannot occlude it

/**
 * Tint per blocker kind (targets.js BK: 1 zombie, 2 barrel, 3 bubble, 4 boss).
 * Secondary channel only -- the number's POSITION already says what was hit.
 * `gain` scales how fast the magnitude ramp saturates, so a 40-damage barrel tick
 * and a 40-damage walker tick do not both sit at the top of the scale.
 */
const KIND_HEX = [
  0xfff0cc,   // 0 unknown -- cream, same as flesh
  0xfff0cc,   // 1 zombie
  0xffc25a,   // 2 barrel  amber
  0xa8eeff,   // 3 bubble  cyan
  0xffd6ee,   // 4 boss    pale rose
]
/** How fast each kind's magnitude ramp saturates. A 40-damage barrel tick and a
 *  40-damage walker tick must not both sit at the top of the scale. */
const KIND_GAIN = [1.0, 1.0, 0.7, 1.0, 0.4]
/** The hot end every tint ramps toward on a big hit. */
const HOT_HEX = 0xff8a30

// Resolved to the renderer's working space ONCE. The shader ends with
// <colorspace_fragment>, so a literal 0..1 triple written straight into the tint
// is treated as LINEAR and comes out visibly washed -- a dark maroon lands as
// pink. Converting here is the difference between a colour and a guess.
const _c = new Color()
const TINT = new Float32Array(KIND_HEX.length * 3)
for (let i = 0; i < KIND_HEX.length; i++) {
  _c.setHex(KIND_HEX[i], SRGBColorSpace)
  TINT[i * 3] = _c.r
  TINT[i * 3 + 1] = _c.g
  TINT[i * 3 + 2] = _c.b
}
_c.setHex(HOT_HEX, SRGBColorSpace)
const HOT_R = _c.r, HOT_G = _c.g, HOT_B = _c.b

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

// The atlas packs coverage in ALPHA and a fill mask in RED, so the dark outline
// survives on both #C2A878 sand and a #C0392B barrel. A single-channel white
// glyph would have to pick one background to become illegible against.
const FS = `
uniform sampler2D uAtlas;
uniform vec3 uOutline;
varying vec2 vAtlas;
varying vec4 vTint;
void main() {
  vec4 t = texture2D(uAtlas, vAtlas);
  if (t.a < 0.02) discard;
  gl_FragColor = vec4(mix(uOutline, vTint.rgb, t.r), t.a * vTint.a);
  #include <colorspace_fragment>
}
`

function makeNumber() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0,
    value: 0, life: 0, age: 0, pop: 0, open: 0, kind: 0, size: 1,
  }
}

/**
 * @param {object} scene
 * @param {{texture: object, cellUv: Function}} atlas the ONE glyph atlas, borrowed --
 *   dispose() does NOT free its texture.
 */
export function createDamageNumbers(scene, atlas) {
  const cap = N_NUMBERS * MAX_DIGITS
  const rng = new Rng(0x1d4a77c3)

  const geo = new PlaneGeometry(1, 1)

  const uvAttr = new InstancedBufferAttribute(new Float32Array(cap * 4), 4)
  const tintAttr = new InstancedBufferAttribute(new Float32Array(cap * 4), 4)
  uvAttr.setUsage(DynamicDrawUsage)
  tintAttr.setUsage(DynamicDrawUsage)
  geo.setAttribute('aUv', uvAttr)
  geo.setAttribute('aTint', tintAttr)

  const mat = new ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas.texture },
      uOutline: { value: new Vector3(0.05, 0.04, 0.02) },
    },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    fog: false,
  })

  const mesh = new InstancedMesh(geo, mat, cap)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  // three culls an InstancedMesh against the geometry bounding sphere sitting at
  // the mesh origin, so every number in the game vanishes the moment the camera
  // leans. No error, no warning -- just a silently missing readout.
  mesh.frustumCulled = false
  mesh.count = 0
  // Above the particles (20) so a number is never buried inside its own
  // impact spray, which is exactly where it is guaranteed to be born.
  mesh.renderOrder = 30
  scene.add(mesh)

  const uvArr = uvAttr.array
  const tintArr = tintAttr.array

  const nums = new Array(N_NUMBERS)
  for (let i = 0; i < N_NUMBERS; i++) nums[i] = makeNumber()
  let live = 0

  const camQ = new Quaternion()

  /** Swap-remove, mirroring the sim pools: live numbers are the prefix [0, live). */
  function release(i) {
    const last = --live
    if (i !== last) {
      const tmp = nums[i]
      nums[i] = nums[last]
      nums[last] = tmp
    }
  }

  /**
   * Report damage against a target at (x, y, z).
   * @param {number} amount raw damage; sub-1 ticks still show as 1 rather than 0,
   *   because "I hit it and nothing appeared" reads as a bug, not as a small hit.
   * @param {number} kind blocker kind from targets.js BK (1 zombie .. 4 boss)
   */
  function add(x, y, z, amount, kind) {
    if (!(amount > 0)) return
    const k = kind >= 0 && kind < KIND_GAIN.length ? kind | 0 : 0

    // Merge into the open number on this target, if there is one.
    for (let i = 0; i < live; i++) {
      const n = nums[i]
      if (n.open <= 0 || n.kind !== k || n.age >= MAX_OPEN) continue
      const dx = n.x - x
      const dz = n.z - z
      if (dx * dx + dz * dz > AGG_RADIUS_SQ) continue
      n.value += amount
      // Follow the body rather than staying where the first round landed: a
      // runner covers 0.45u per frame and the number would visibly trail it.
      n.x = x
      n.z = z
      n.pop = 1
      const room = MAX_OPEN - n.age
      const win = CFG.fx.damageAggregation
      n.open = room < win ? room : win
      return
    }

    if (live >= N_NUMBERS) {
      // Steal the oldest instead of dropping the newest. A number the player has
      // already read is worth less than the one describing what just happened.
      let oldest = 0
      let best = nums[0].life
      for (let i = 1; i < live; i++) if (nums[i].life < best) { best = nums[i].life; oldest = i }
      release(oldest)
    }
    const n = nums[live++]
    n.x = x
    n.y = y
    n.z = z
    n.vx = rng.range(-DRIFT, DRIFT)
    n.vy = RISE
    n.value = amount
    n.life = LIFE
    n.age = 0
    n.pop = 1
    n.open = CFG.fx.damageAggregation
    n.kind = k
    n.size = SIZE
  }

  function sync(w, dt, camera) {
    if (camera && camera.isCamera) {
      camQ.copy(camera.quaternion)
      // The camera's world X axis, so digits lay out left-to-right ON SCREEN.
      // Advancing along world X instead would shear the number as the rig rolls.
      const e = camera.matrixWorld.elements
      _right.set(e[0], e[1], e[2])
    }

    const scroll = w.scroll
    for (let i = live - 1; i >= 0; i--) {
      const n = nums[i]
      n.age += dt
      if (n.open > 0) {
        n.open -= dt
      } else {
        n.life -= dt
        if (n.life <= 0) { release(i); continue }
      }
      n.pop -= n.pop * POP_DECAY * dt
      n.vy -= n.vy * RISE_DAMP * dt
      n.x += n.vx * dt
      n.y += n.vy * dt
      // Carried by the corridor like everything else standing on it. A number
      // pinned in world Z falls 11 units behind its own zombie in one lifetime,
      // which reads as the number belonging to whatever is behind it now.
      n.z += scroll * dt
    }

    // Full rebuild over the live prefix. Never incremental: release() swap-removes,
    // so any index-tracking scheme is a flicker bug by construction.
    let g = 0
    for (let i = 0; i < live; i++) {
      const n = nums[i]
      let v = Math.round(n.value)
      if (v < 1) v = 1
      if (v > 9999) v = 9999
      const digits = v >= 1000 ? 4 : v >= 100 ? 3 : v >= 10 ? 2 : 1

      // Magnitude ramp: bigger hits are bigger and hotter. This is the only
      // reason a tier change is visible in the numbers at all, since DPS also
      // rises with squad size and the raw value alone confounds the two.
      const t3 = n.kind * 3
      const heat = clamp(v * KIND_GAIN[n.kind] / 60, 0, 1)
      const r = TINT[t3] + (HOT_R - TINT[t3]) * heat
      const gg = TINT[t3 + 1] + (HOT_G - TINT[t3 + 1]) * heat
      const b = TINT[t3 + 2] + (HOT_B - TINT[t3 + 2]) * heat

      const fade = n.open > 0 ? 1 : clamp(n.life / (LIFE * 0.55), 0, 1)
      const scale = n.size * (1 + POP * n.pop) * (0.82 + 0.30 * heat)
        * Math.pow(SIZE_PER_DIGIT, digits - 1)
      const adv = scale * ADVANCE
      const x0 = -((digits - 1) * adv) * 0.5

      let rest = v
      for (let d = digits - 1; d >= 0; d--) {
        if (g >= cap) break
        const digit = rest % 10
        rest = (rest / 10) | 0
        const off = x0 + d * adv
        _pos.set(
          n.x + _right.x * off,
          n.y + _right.y * off,
          n.z + Z_LIFT + _right.z * off,
        )
        _scl.set(scale, scale, 1)
        _quat.copy(camQ)
        _m4.compose(_pos, _quat, _scl)
        mesh.setMatrixAt(g, _m4)

        atlas.cellUv(CODE_0 + digit, _uv)
        const o4 = g * 4
        uvArr[o4] = _uv.x
        uvArr[o4 + 1] = _uv.y
        uvArr[o4 + 2] = _uv.z
        uvArr[o4 + 3] = _uv.w
        tintArr[o4] = r
        tintArr[o4 + 1] = gg
        tintArr[o4 + 2] = b
        tintArr[o4 + 3] = fade
        g++
      }
    }

    mesh.count = g
    mesh.instanceMatrix.needsUpdate = true
    // Each buffer gets its OWN flag. Riding instanceMatrix.needsUpdate freezes
    // every glyph at whatever character and colour it held at boot while the
    // quads keep flying around -- numbers that move but never change, no error.
    uvAttr.needsUpdate = true
    tintAttr.needsUpdate = true
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

  return { add, sync, reset, dispose }
}
