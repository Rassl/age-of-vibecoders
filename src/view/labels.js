/**
 * World-space count labels: the squad's headcount floating over the formation,
 * and a headcount over every zombie cluster on the road.
 *
 * The reference runners put the number ON the crowd it describes, and that is
 * the whole point: a count in a HUD corner has to be looked away from the
 * action to be read, and a horde with no number is a texture rather than a
 * threat you can price. The squad label is the ONE number the player must
 * never lose track of, so it carries the gain/loss punch the DOM count used to.
 *
 * Clusters are found HERE, in the view, by greedy proximity grouping over the
 * live zombie pool -- the sim has no cluster concept and must not grow one for
 * a presentation feature. The grouping is O(zombies x clusters) per frame over
 * fixed preallocated arrays: no allocation, no sort, no Map.
 *
 * Glyphs come from the ONE baked atlas (view/atlas.js). No runtime fillText.
 */
import {
  DynamicDrawUsage, FrontSide, InstancedBufferAttribute, InstancedMesh, Matrix4,
  PlaneGeometry, Quaternion, ShaderMaterial, Vector3, Vector4, Color, SRGBColorSpace,
} from 'three'
import { CFG } from '../config.js'
import { clamp } from '../util/math.js'

const _m4 = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
const _quat = new Quaternion()
const _right = new Vector3(1, 0, 0)
const _uv = new Vector4()
const _c = new Color()

const CODE_0 = 48
const MAX_DIGITS = 3            // squad cap 250, zombie pool 220
const MAX_CLUSTERS = 24
const CAP = (1 + MAX_CLUSTERS) * MAX_DIGITS

// ---- squad label
const SQUAD_Y = 2.75            // clear of a helmet (~1.9) and the muzzle flash
const SQUAD_SIZE = 0.80
const SQUAD_MIN_PX = 34
const SQUAD_MAX_K = 2.2
const SQUAD_Z_LIFT = 0.6        // toward the camera, off the back rank's heads
const PUNCH_DUR = 0.26
const PUNCH_AMP = 0.45
const FLASH_HOLD = 0.32

// ---- cluster labels
const CLUSTER_Y = 2.45
const CLUSTER_SIZE = 0.62
const CLUSTER_MIN_PX = 24
const CLUSTER_MAX_K = 2.6
const CLUSTER_Z_LIFT = 0.9
const CLUSTER_MIN = 3           // one or two walkers are bodies, not a crowd
// Grouping radius. X is a lane (3u); Z is a little more than one cluster's own
// spread, so two waves that spawned 6s apart stay two numbers.
const GROUP_DX = 1.7
const GROUP_DZ = 3.4
const FAR_Z = -70               // fade in just inside the 72u spawn horizon
const NEAR_Z = 0.5              // past the squad plane the count is moot
// Scale by headcount: a 20-body wall must read bigger than a pair, and this is
// the only way the number carries "mass" the way the reference's red blob does.
const COUNT_GAIN = 0.55
const COUNT_REF = 18

const ADVANCE = 0.64

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

/** sRGB hex -> working-space triple, once at boot (see damagenumbers.js). */
function lin(hex) {
  _c.setHex(hex, SRGBColorSpace)
  return [_c.r, _c.g, _c.b]
}

const T_SQUAD = lin(0xd8f4ff)     // cool white, the squad's cyan family
const T_GAIN = lin(0x7cf07a)
const T_LOSS = lin(0xff5a4a)
const T_CLUSTER = lin(0xffc4b8)   // pale rose, the horde's red family
const T_CLUSTER_HOT = lin(0xff4a36)

export function createLabels(scene, atlas) {
  const geo = new PlaneGeometry(1, 1)
  const uvAttr = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4)
  const tintAttr = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4)
  uvAttr.setUsage(DynamicDrawUsage)
  tintAttr.setUsage(DynamicDrawUsage)
  geo.setAttribute('aUv', uvAttr)
  geo.setAttribute('aTint', tintAttr)

  const mat = new ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas.texture },
      uOutline: { value: new Vector3(0.04, 0.03, 0.03) },
    },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    // No depth test: a headcount is a HUD element that happens to live in the
    // world, and it must never be hidden by whatever is standing in front of
    // the crowd it counts -- the escort drone orbits at exactly label height.
    depthTest: false,
    side: FrontSide,
    fog: false,
  })

  const mesh = new InstancedMesh(geo, mat, CAP)
  mesh.name = 'labels'
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  // Culled against a bounding sphere at the origin otherwise -- every label
  // vanishes the moment the camera leans. See VIEW_CONTRACT rule 1.
  mesh.frustumCulled = false
  mesh.count = 0
  // Under the damage numbers (30): a hit readout is the more urgent of the two
  // when they overlap, and above the particles (20) so a label is never
  // buried in the spray of the crowd it is counting.
  mesh.renderOrder = 29
  scene.add(mesh)

  const uvArr = uvAttr.array
  const tintArr = tintAttr.array
  const camQ = new Quaternion()

  // ---- cluster scratch, fixed size
  const cX = new Float32Array(MAX_CLUSTERS)
  const cZ = new Float32Array(MAX_CLUSTERS)
  const cSumX = new Float32Array(MAX_CLUSTERS)
  const cSumZ = new Float32Array(MAX_CLUSTERS)
  const cN = new Int32Array(MAX_CLUSTERS)

  // ---- squad label state (view-owned)
  let lastCount = -1
  let punchT = 99
  let punchDir = 1
  let g = 0

  // Camera basis for the apparent-size floor (props.js has the long note).
  let pxK = 0
  let camX = 0, camY = 0, camZ = 0
  let fwdX = 0, fwdY = 0, fwdZ = -1

  function apparentK(x, y, z, base, minPx, maxK) {
    if (pxK <= 0) return 1
    const d = (x - camX) * fwdX + (y - camY) * fwdY + (z - camZ) * fwdZ
    if (d <= 0.01) return 1
    const k = (minPx * pxK * d) / base
    return k < 1 ? 1 : k > maxK ? maxK : k
  }

  /** Lay out one integer, centred on (x, y, z) along the camera's X axis. */
  function emit(v, x, y, z, size, r, gg, b, a) {
    if (v < 0) v = 0
    if (v > 999) v = 999
    const digits = v >= 100 ? 3 : v >= 10 ? 2 : 1
    const adv = size * ADVANCE
    const x0 = -((digits - 1) * adv) * 0.5
    let rest = v
    for (let d = digits - 1; d >= 0; d--) {
      if (g >= CAP) return
      const digit = rest % 10
      rest = (rest / 10) | 0
      const off = x0 + d * adv
      _pos.set(x + _right.x * off, y + _right.y * off, z + _right.z * off)
      _scl.set(size, size, 1)
      _quat.copy(camQ)
      _m4.compose(_pos, _quat, _scl)
      mesh.setMatrixAt(g, _m4)
      atlas.cellUv(CODE_0 + digit, _uv)
      const o = g * 4
      uvArr[o] = _uv.x; uvArr[o + 1] = _uv.y; uvArr[o + 2] = _uv.z; uvArr[o + 3] = _uv.w
      tintArr[o] = r; tintArr[o + 1] = gg; tintArr[o + 2] = b; tintArr[o + 3] = a
      g++
    }
  }

  function sync(w, dt, camera) {
    if (!(dt > 0)) dt = 0
    if (camera && camera.isCamera) {
      camQ.copy(camera.quaternion)
      const e = camera.matrixWorld.elements
      _right.set(e[0], e[1], e[2])
      fwdX = -e[8]; fwdY = -e[9]; fwdZ = -e[10]
      camX = e[12]; camY = e[13]; camZ = e[14]
      pxK = (2 * Math.tan(camera.fov * Math.PI / 360)) / (CFG.derived.canvasCssH || 900)
    }

    g = 0
    const live = w.state === 1 || w.state === 2

    // ---------------------------------------------------------- squad -----
    if (live && w.count > 0) {
      if (lastCount >= 0 && w.count !== lastCount) {
        const dir = w.count > lastCount ? 1 : -1
        // A loss retriggers over a gain, never the reverse (same rule as the
        // HUD punch): the red pop must not be eaten by a bubble landing.
        if (!(dir > 0 && punchDir < 0 && punchT < PUNCH_DUR)) { punchT = 0; punchDir = dir }
      }
      lastCount = w.count
      if (punchT < 10) punchT += dt

      // Centroid of the bodies AS DRAWN: view/characters.js renders each soldier
      // at its view-owned smoothed (vx, vz), which trails the sim (x, z) by up
      // to ~0.2s on the rim. Reading the sim position put the label a lane
      // ahead of the crowd during the turret round's self-driven lane changes.
      const sp = w.soldiers
      let sx = 0, sz = 0
      const n = sp.size
      for (let i = 0; i < n; i++) { const s = sp.items[i]; sx += s.vx; sz += s.vz }
      if (n > 0) { sx /= n; sz /= n } else { sx = w.anchorX; sz = 0 }

      let punch = 0
      if (punchT < PUNCH_DUR) {
        const t = punchT / PUNCH_DUR
        punch = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7
      }
      const flash = punchT < FLASH_HOLD ? 1 - punchT / FLASH_HOLD : 0
      const ft = punchDir > 0 ? T_GAIN : T_LOSS
      const r = T_SQUAD[0] + (ft[0] - T_SQUAD[0]) * flash
      const gg = T_SQUAD[1] + (ft[1] - T_SQUAD[1]) * flash
      const b = T_SQUAD[2] + (ft[2] - T_SQUAD[2]) * flash

      // Rides the wings lift so the count stays over the helmets, not in them.
      const y = SQUAD_Y + w.altitude * CFG.wings.height
      const z = sz + SQUAD_Z_LIFT
      const k = apparentK(sx, y, z, SQUAD_SIZE, SQUAD_MIN_PX, SQUAD_MAX_K)
      emit(w.count, sx, y, z, SQUAD_SIZE * k * (1 + PUNCH_AMP * punch), r, gg, b, 1)
    } else {
      lastCount = -1
      punchT = 99
    }

    // -------------------------------------------------------- clusters -----
    let nc = 0
    if (live) {
      const zp = w.zombies
      const zn = zp.size
      for (let i = 0; i < zn; i++) {
        const z = zp.items[i]
        if (z.dead || z.z < FAR_Z || z.z > NEAR_Z) continue
        // Nearest existing cluster inside the grouping box, by centroid.
        let best = -1
        let bestD = Infinity
        for (let c = 0; c < nc; c++) {
          const dx = Math.abs(z.x - cX[c])
          const dz = Math.abs(z.z - cZ[c])
          if (dx > GROUP_DX || dz > GROUP_DZ) continue
          const d = dx + dz
          if (d < bestD) { bestD = d; best = c }
        }
        if (best < 0) {
          if (nc < MAX_CLUSTERS) {
            best = nc++
            cSumX[best] = 0; cSumZ[best] = 0; cN[best] = 0
          } else {
            // Out of slots: fold into the nearest cluster regardless of box.
            for (let c = 0; c < nc; c++) {
              const d = Math.abs(z.x - cX[c]) + Math.abs(z.z - cZ[c])
              if (d < bestD) { bestD = d; best = c }
            }
          }
        }
        cSumX[best] += z.x
        cSumZ[best] += z.z
        cN[best]++
        cX[best] = cSumX[best] / cN[best]
        cZ[best] = cSumZ[best] / cN[best]
      }
    }

    for (let c = 0; c < nc; c++) {
      const n = cN[c]
      if (n < CLUSTER_MIN) continue
      const x = cX[c]
      const cz = cZ[c]
      // Fade in from the horizon, out past the squad plane.
      const a = clamp((cz - FAR_Z) / 10, 0, 1) * clamp((NEAR_Z - cz) / 2.5, 0, 1)
      if (a <= 0.02) continue
      const heat = clamp(n / COUNT_REF, 0, 1)
      const r = T_CLUSTER[0] + (T_CLUSTER_HOT[0] - T_CLUSTER[0]) * heat
      const gg = T_CLUSTER[1] + (T_CLUSTER_HOT[1] - T_CLUSTER[1]) * heat
      const b = T_CLUSTER[2] + (T_CLUSTER_HOT[2] - T_CLUSTER[2]) * heat
      const base = CLUSTER_SIZE * (1 + COUNT_GAIN * heat)
      const y = CLUSTER_Y
      const z = cz + CLUSTER_Z_LIFT
      const k = apparentK(x, y, z, base, CLUSTER_MIN_PX, CLUSTER_MAX_K)
      emit(n, x, y, z, base * k, r, gg, b, a)
    }

    mesh.count = g
    mesh.instanceMatrix.needsUpdate = true
    // Each buffer gets its OWN flag (VIEW_CONTRACT rule 2).
    uvAttr.needsUpdate = true
    tintAttr.needsUpdate = true
  }

  function reset() {
    lastCount = -1
    punchT = 99
    punchDir = 1
    g = 0
    mesh.count = 0
  }

  function dispose() {
    scene.remove(mesh)
    mesh.dispose()
    geo.dispose()
    mat.dispose()
  }

  return { sync, reset, dispose }
}
