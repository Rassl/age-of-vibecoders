/**
 * Gate rows: the panels the squad DRIVES THROUGH.
 *
 * Owns its own meshes rather than extending src/view/props.js, which binds a
 * prop to one of two per-slot entity groups by `kind === 'barrel'`. Adding a
 * third kind there means a three-way binding across two passes plus a third
 * update path, in a 1000-line module whose barrel shader it would share nothing
 * with. Gates share the sim's prop pool and nothing else.
 *
 * A row must read as ONE object with a seam, not as separate props: the whole
 * decision is "which side am I on", so the panels are drawn edge to edge with a
 * post at every boundary and the number sits dead centre of its own segment.
 *
 * Everything is instanced and every buffer is sized to the prop pool, because a
 * gate that fails to draw is an invisible tax.
 */
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, Color, DoubleSide,
  DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Object3D, PlaneGeometry, Quaternion, ShaderMaterial, Vector3, Vector4,
} from 'three'

import { CFG } from '../config.js'

const _pos = new Vector3()
const _scl = new Vector3()
const _uv = new Vector4()
const _mat = new Matrix4()
const _QI = new Quaternion()
const _dummy = new Object3D()

const CODE_0 = 48
const CODE_PLUS = 43
const CODE_MINUS = 45

const MAX_DIGITS = 3          // '-14' is the widest value the table authors
// The number IS the plate. Sized so a two-digit value fills about half the
// panel height and reads from the spawn distance without the px floor kicking
// in on a phone; the floor below only catches very tall viewports.
const GLYPH_SIZE = 1.05
const GLYPH_ADVANCE = 0.56
// Never let the number outgrow its own segment: the width tug-of-war can
// squeeze a panel to 2 * CFG.gate.minHalfW, and a three-glyph "-14" at full
// size is wider than that.
const GLYPH_FIT = 0.92

// Apparent-size floor -- see the long note in src/view/props.js. Gates spawn at
// z=-34 rather than the 72u content horizon, so this readout is only marginal
// (9.2px of ink at spawn) rather than broken, and it needs the least help: the
// solid panel behind the glyph gives it contrast the other readouts lack, and a
// row splits the corridor into 2-3 segments only 70-106px wide, so an oversized
// '+12' would overflow its own segment.
const GLYPH_MIN_PX = 30
const GLYPH_MAX_K = 2.0

// Reference palette: a saturated blue for gain, a hot red for loss. They must be
// separable at the far end of the corridor with the fog on them, so both are
// pushed well clear of the grey road rather than being tinted pastels.
const C_GAIN = new Color(0x1E7CFF)
const C_LOSS = new Color(0xFF3A2E)
const C_GAIN_RIM = new Color(0xA8E4FF)
const C_LOSS_RIM = new Color(0xFFC8B4)
const TINT_TEXT = new Color(0xFFFFFF)
const TINT_OUTLINE = new Color(0x12212F)

const PANEL_VS = `
attribute vec4 aTint;      // rgb = panel colour, a = fade
attribute vec2 aFlags;     // x = rim strength, y = scroll phase
varying vec2 vUv;
varying vec4 vTint;
varying vec2 vFlags;
void main() {
  vUv = uv;
  vTint = aTint;
  vFlags = aFlags;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`

// The panel is a flat translucent sheet with a bright border and a slow vertical
// wipe. No lighting: it is a hologram, and shading it would make it read as a
// solid wall the player must shoot rather than one to walk through.
const PANEL_FS = `
precision mediump float;
varying vec2 vUv;
varying vec4 vTint;
varying vec2 vFlags;
void main() {
  vec2 d = abs(vUv - 0.5) * 2.0;
  float edge = max(d.x, d.y);
  float border = smoothstep(0.80, 0.99, edge);
  float wipe = 0.5 + 0.5 * sin((vUv.y * 5.0) - vFlags.y * 3.0);
  // Denser than the old 0.34: a hologram this faint disappeared against a
  // lit road. Still translucent, so bodies behind it stay visible.
  float body = 0.58 + 0.14 * wipe;
  vec3 col = mix(vTint.rgb, vTint.rgb + vec3(0.55), border * vFlags.x);
  float a = (body + border * 0.75) * vTint.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}`

const POST_VS = `
attribute vec4 aTint;
varying vec4 vTint;
varying float vUpY;
void main() {
  vTint = aTint;
  vUpY = position.y + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const POST_FS = `
precision mediump float;
varying vec4 vTint;
varying float vUpY;
void main() {
  vec3 col = vTint.rgb + vec3(0.25) * vUpY;
  gl_FragColor = vec4(col, vTint.a);
}`

const GLYPH_VS = `
attribute vec4 aUv;
varying vec2 vUv;
varying float vFade;
attribute float aFade;
void main() {
  vUv = aUv.xy + uv * aUv.zw;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const GLYPH_FS = `
precision mediump float;
uniform sampler2D uAtlas;
uniform vec3 uTint;
uniform vec3 uOutline;
varying vec2 vUv;
varying float vFade;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < 0.02) discard;
  gl_FragColor = vec4(mix(uOutline, uTint, t.r), t.a * vFade);
}`

export function createGates(scene, atlas) {
  // One entry per prop-pool slot: every gate segment alive in the sim must have
  // somewhere to draw, and a row is several segments at once.
  const N = CFG.pool.props

  const root = new Group()
  root.name = 'gates'
  scene.add(root)

  const geos = []
  const mats = []
  const keep = (arr, x) => { arr.push(x); return x }

  const h = CFG.gate.height

  // Panels are DoubleSide: the squad passes through them, so for a frame or two
  // the camera is behind the sheet and a single-sided panel vanishes.
  const panelGeo = keep(geos, new PlaneGeometry(1, 1))
  const panelMat = keep(mats, new ShaderMaterial({
    uniforms: {},
    vertexShader: PANEL_VS,
    fragmentShader: PANEL_FS,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  }))
  const panelTint = new InstancedBufferAttribute(new Float32Array(N * 4), 4)
  const panelFlags = new InstancedBufferAttribute(new Float32Array(N * 2), 2)
  panelTint.setUsage(DynamicDrawUsage)
  panelFlags.setUsage(DynamicDrawUsage)
  panelGeo.setAttribute('aTint', panelTint)
  panelGeo.setAttribute('aFlags', panelFlags)
  const panels = new InstancedMesh(panelGeo, panelMat, N)
  panels.frustumCulled = false
  panels.count = 0
  panels.renderOrder = 6
  root.add(panels)

  // Two posts per segment (both edges). Neighbouring segments overdraw the
  // shared seam, which is what makes a row read as one barrier.
  const postGeo = keep(geos, new BoxGeometry(CFG.gate.postHalf * 2, h, CFG.gate.thickness * 1.6))
  const postMat = keep(mats, new ShaderMaterial({
    uniforms: {},
    vertexShader: POST_VS,
    fragmentShader: POST_FS,
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
  }))
  const postTint = new InstancedBufferAttribute(new Float32Array(N * 2 * 4), 4)
  postTint.setUsage(DynamicDrawUsage)
  postGeo.setAttribute('aTint', postTint)
  const posts = new InstancedMesh(postGeo, postMat, N * 2)
  posts.frustumCulled = false
  posts.count = 0
  posts.renderOrder = 7
  root.add(posts)

  const glyphGeo = keep(geos, new BufferGeometry())
  glyphGeo.setIndex(panelGeo.index)
  glyphGeo.setAttribute('position', panelGeo.attributes.position)
  glyphGeo.setAttribute('uv', panelGeo.attributes.uv)
  const glyphUv = new InstancedBufferAttribute(new Float32Array(N * MAX_DIGITS * 4), 4)
  const glyphFade = new InstancedBufferAttribute(new Float32Array(N * MAX_DIGITS), 1)
  glyphUv.setUsage(DynamicDrawUsage)
  glyphFade.setUsage(DynamicDrawUsage)
  glyphGeo.setAttribute('aUv', glyphUv)
  glyphGeo.setAttribute('aFade', glyphFade)
  const glyphMat = keep(mats, new ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas.texture },
      uTint: { value: TINT_TEXT.clone() },
      uOutline: { value: TINT_OUTLINE.clone() },
    },
    vertexShader: GLYPH_VS,
    fragmentShader: GLYPH_FS,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  }))
  const glyphs = new InstancedMesh(glyphGeo, glyphMat, N * MAX_DIGITS)
  glyphs.frustumCulled = false
  glyphs.count = 0
  glyphs.renderOrder = 8
  root.add(glyphs)

  let clock = 0

  function sync(w, dt, a, b) {
    const camera = b && b.isCamera ? b : a && a.isCamera ? a : null
    clock += dt > 0 ? dt : 0

    // Camera basis for the apparent-size floor, once per frame. The camera was
    // already threaded into this function and discarded (`void camera`).
    let pxK = 0
    let camX = 0, camY = 0, camZ = 0
    let fwdX = 0, fwdY = 0, fwdZ = -1
    if (camera) {
      const el = camera.matrixWorld.elements
      fwdX = -el[8]; fwdY = -el[9]; fwdZ = -el[10]
      camX = el[12]; camY = el[13]; camZ = el[14]
      pxK = (2 * Math.tan(camera.fov * Math.PI / 360)) / (CFG.derived.canvasCssH || 900)
    }

    const pool = w.props
    const n = pool.size
    const tintArr = panelTint.array
    const flagArr = panelFlags.array
    const postArr = postTint.array
    const uvArr = glyphUv.array
    const fadeArr = glyphFade.array

    let nPanel = 0
    let nPost = 0
    let nGlyph = 0

    for (let i = 0; i < n; i++) {
      const p = pool.items[i]
      if (p.dead || p.kind !== 'gate') continue

      const gain = p.value >= 0
      const col = gain ? C_GAIN : C_LOSS
      const rim = gain ? C_GAIN_RIM : C_LOSS_RIM
      const width = p.halfW * 2

      // Fade in over the last stretch of the approach rather than popping in at
      // the 72u horizon, and fade out as the row passes under the camera so the
      // panel does not clip through the lens.
      // Fade measured from the gate's own spawn distance, not a fixed depth:
      // rows appear at CFG.gate.spawnZ, so a horizon-based ramp would have them
      // pop in already fully opaque.
      const fade = clamp01((p.z - CFG.gate.spawnZ) / 7) * clamp01((2.5 - p.z) / 3.0)
      if (fade <= 0.01) continue

      // ---- panel
      _pos.set(p.x, CFG.gate.y + h * 0.5, p.z)
      _scl.set(Math.max(0.05, width - CFG.gate.postHalf * 2), h, 1)
      _mat.compose(_pos, _QI, _scl)
      panels.setMatrixAt(nPanel, _mat)
      let o = nPanel * 4
      tintArr[o] = col.r; tintArr[o + 1] = col.g; tintArr[o + 2] = col.b; tintArr[o + 3] = fade
      o = nPanel * 2
      flagArr[o] = 1
      flagArr[o + 1] = clock + p.x
      nPanel++

      // ---- posts at both edges
      for (let s = -1; s <= 1; s += 2) {
        _dummy.position.set(p.x + s * p.halfW, CFG.gate.y + h * 0.5, p.z)
        _dummy.rotation.set(0, 0, 0)
        _dummy.scale.set(1, 1, 1)
        _dummy.updateMatrix()
        posts.setMatrixAt(nPost, _dummy.matrix)
        const q = nPost * 4
        postArr[q] = rim.r; postArr[q + 1] = rim.g; postArr[q + 2] = rim.b; postArr[q + 3] = fade
        nPost++
      }

      // ---- the signed number, centred in its own segment
      //
      // Straight from p.value: the sim caps a penalty ONCE at spawn, so the
      // stored value already IS the true cost. Re-deriving it here against the
      // live squad count each frame is what made a plate under fire display
      // -5 -5 -5 -7 -8 -2 -- frozen, then moving backwards.
      const v = p.value
      const mag = Math.abs(v)
      const digits = mag >= 100 ? 3 : mag >= 10 ? 2 : 1
      const chars = 1 + digits            // sign + digits

      // View DEPTH, not radial distance -- radial is off by cos(off-axis angle),
      // which matters for the outer segments of a wide row.
      const gy = CFG.gate.y + h * 0.58
      let k = 1
      if (pxK > 0) {
        const d = (p.x - camX) * fwdX + (gy - camY) * fwdY + (p.z - camZ) * fwdZ
        if (d > 0.01) {
          const raw = (GLYPH_MIN_PX * pxK * d) / GLYPH_SIZE
          k = raw < 1 ? 1 : raw > GLYPH_MAX_K ? GLYPH_MAX_K : raw
        }
      }
      // Advance scales WITH size, or the glyphs grow into each other -- and the
      // whole string is clamped to its segment so a squeezed panel keeps its
      // number inside its own posts.
      const fitK = (width * GLYPH_FIT) / ((chars - 1) * GLYPH_ADVANCE + GLYPH_SIZE)
      if (fitK < k) k = fitK
      const adv = GLYPH_ADVANCE * k
      const gsize = GLYPH_SIZE * k
      const x0 = p.x - ((chars - 1) * adv) * 0.5
      for (let c = 0; c < chars; c++) {
        const code = c === 0
          ? (v >= 0 ? CODE_PLUS : CODE_MINUS)
          : CODE_0 + digitAt(mag, digits, c - 1)
        atlas.cellUv(code, _uv)
        const u = nGlyph * 4
        uvArr[u] = _uv.x; uvArr[u + 1] = _uv.y; uvArr[u + 2] = _uv.z; uvArr[u + 3] = _uv.w
        fadeArr[nGlyph] = fade

        _pos.set(x0 + c * adv, gy, p.z + 0.05)
        _scl.set(gsize, gsize, 1)
        _mat.compose(_pos, _QI, _scl)
        glyphs.setMatrixAt(nGlyph, _mat)
        nGlyph++
      }
    }

    panels.count = nPanel
    posts.count = nPost
    glyphs.count = nGlyph
    panels.instanceMatrix.needsUpdate = true
    posts.instanceMatrix.needsUpdate = true
    glyphs.instanceMatrix.needsUpdate = true
    panelTint.needsUpdate = true
    panelFlags.needsUpdate = true
    postTint.needsUpdate = true
    glyphUv.needsUpdate = true
    glyphFade.needsUpdate = true
  }

  function reset() {
    panels.count = 0
    posts.count = 0
    glyphs.count = 0
  }

  function dispose() {
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    scene.remove(root)
  }

  return { sync, reset, dispose, root }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

/** Digit `i` (left to right) of a `len`-digit magnitude, without allocating. */
function digitAt(mag, len, i) {
  let div = 1
  for (let k = 0; k < len - 1 - i; k++) div *= 10
  return ((mag / div) | 0) % 10
}
