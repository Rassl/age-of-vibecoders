/**
 * Barrels and bubbles -- the two objects the player actually makes a DECISION
 * about, and the only reason the drag matters.
 *
 * Everything here is built around one number: a prop spawns at z = -72 and the
 * corridor scrolls at 14-18 u/s, so the player has ~4.5 seconds and commits in
 * the first second. That means every readout has to survive being 60+ units away
 * and about 30 screen pixels tall, so each one is doubled: a NUMBER for the exact
 * cost and a NON-NUMERIC channel for the glance.
 *   barrel -> printed HP  +  a vertical fill wipe that drains like a liquid level
 *   bubble -> a badge     +  a real 3D reward object and a draining progress ring
 * Kill the second channel and the gate stops being legible at the distance where
 * the choice is actually made.
 *
 * Both are plain Meshes, not instanced: at most a handful are live and each needs
 * its own uniforms (own HP fraction, own pulse phase, own reward). That is below
 * the instancing line in the view contract.
 *
 * `atlas` is borrowed, not owned -- dispose() does NOT free its texture.
 */
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  CylinderGeometry, DynamicDrawUsage, FrontSide, Group, IcosahedronGeometry,
  InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  Object3D, PlaneGeometry, Quaternion, RepeatWrapping, ShaderMaterial,
  SphereGeometry, TorusGeometry, Vector3, Vector4,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CFG } from '../config.js'
import { clamp, lerp, remap } from '../util/math.js'
import { soldiersPerBubble } from '../curves.js'
import { WEAPONS, MAX_TIER } from '../data/weapons.js'
import { Rng } from '../util/rng.js'

// ---------------------------------------------------------------- frame scratch
// Hoisted to module scope: sync() runs at 60Hz over a dozen props and must not
// hand the GC a single object.
const _pos = new Vector3()
const _scl = new Vector3()
const _uv = new Vector4()
const _mat = new Matrix4()
const _QI = new Quaternion()

// Boot-only scratch, used by the geometry builders before the first frame.
const _dummy = new Object3D()

const TAU = Math.PI * 2
const CODE_0 = 48
const CODE_PLUS = 43

const MAX_DIGITS = 4        // wall HP tops out around 4000 at the end of the run
const MAX_BADGE = 8         // 'SHOTGUN' is the longest word a bubble can print

// Bubble reward kinds. Was a boolean, which is what silently swallowed drones.
const K_BODIES = 0
const K_WEAPON = 1
const K_DRONE = 2

/**
 * Two-letter reward tokens. ALWAYS, at every distance.
 *
 * Scaling alone cannot save this label at range: 'SHOTGUN' is 7 characters, and
 * held at the 22px floor it spans ~104px inside a corridor only ~126px wide at
 * the spawn horizon -- 83% of the lane, so a gated pair's two bubbles smear into
 * one. But swapping to the short form only while clamping had it backwards: the
 * full word then appeared in the NEAR field, which is exactly where the badge is
 * physically biggest, and 'DRONE' on a right-lane bubble ran off the edge of the
 * screen.
 *
 * Near is also where the badge matters least -- the bubble's own 3D reward model
 * (trio / gun / drone token) is plainly readable at that size and carries the
 * identity by itself. So the token is short everywhere: it does the work in the
 * far field where the model is a blob, and never fights the frame up close.
 * Every letter is already baked in GLYPH_CHARS, so this costs no re-bake.
 */
const SHORT_WORD = { PISTOL: 'PS', SMG: 'SM', RIFLE: 'RF', SHOTGUN: 'SG', MINIGUN: 'MG', DRONE: 'DR' }
const POP_TIME = 0.11
const POP_SCALE = 0.22

/**
 * APPARENT-SIZE FLOOR for world-space text.
 *
 * A billboard at a fixed world size shrinks with distance, and this corridor is
 * 72 units deep: a barrel's HP measured 38px on arrival and 7.7px at the spawn
 * horizon, well under the ~11px a bold glyph needs. But the answer is a FLOOR,
 * not constant size. Two reasons, both measured: the corridor is only ~135 CSS
 * px wide at the horizon, so three lanes get ~45px each and genuinely
 * constant-size labels collide -- a barrel's HP and its own gated bubble's badge
 * overlap from z=-35 outward; and flattening the near field would delete the
 * "this one is about to hit you" emphasis that the growth toward the camera
 * carries.
 *
 * So: perspective as authored up close, held flat once it would drop below the
 * floor. C0-continuous at the knee, so there is no pop.
 */
const DIGIT_MIN_PX = 24
const DIGIT_MAX_K = 3.2
const BADGE_MIN_PX = 22
const BADGE_MAX_K = 4.0

const DIGIT_SIZE = 0.52
const DIGIT_ADVANCE = 0.34
const DIGIT_Y = 1.35
// The NARROW cluster is built set back (drums at z=-0.22, r=0.75 -> front face
// +0.53), so 0.62 clears it. The WALL cluster is not: its x=+/-1.8 drums sit at
// z=+0.10 with r=0.90, so their faces are at +1.00 -- a third of a unit IN FRONT
// of the narrow plane. The digit material is depthWrite:false but depthTest is
// on, so a wall's own drums ate the middle of its own HP number. Walls need
// their own plane, clear of both the drums and the billboard's z-extent when the
// apparent-size clamp has scaled it up.
const DIGIT_Z = 0.62
const DIGIT_Z_WALL = 1.40
const BADGE_SIZE = 0.36
const BADGE_ADVANCE = 0.225
const BADGE_Y = 1.30

// Time-to-kill vs time-remaining. Under 0.55 the barrel dies with margin; over
// 1.0 it is arithmetically unkillable and the player should be reading "dodge".
const TTK_GOOD = 0.55
const TTK_WARN = 1.0

const TINT_GOOD = new Color(0x8BE06A)
const TINT_WARN = new Color(0xF0C24A)
const TINT_BAD = new Color(0xF0554A)
const TINT_BADGE = new Color(0xCFF6FF)
const TINT_OUTLINE = new Color(0x120D08)

/**
 * three's Color applies the sRGB -> working-space conversion; a raw GLSL vec3
 * literal does not. Baking the converted value into the shader source at boot is
 * what keeps these swatches matching the palette table instead of arriving
 * washed out by one gamma.
 */
function glsl(hex) {
  const c = new Color(hex)
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}

const C_HEALTHY = glsl(0xC0392B)
const C_DAMAGED = glsl(0x5A2A22)
const C_TRIM = glsl(0x6A625A)
const C_HAZARD = glsl(0xE8B93B)
const C_HOT = glsl(0xFFB070)
const C_WARN = glsl(0xFFD24A)
const C_SHELL = glsl(0x7FE8FF)
const C_RING = glsl(0x54D6F5)

// ---------------------------------------------------------------------- shaders

const BARREL_VS_HEAD = `
attribute float aShell;
varying float vShell;
`

const BARREL_FS_HEAD = `
varying float vShell;
uniform float uHp;
uniform float uPulse;
uniform float uFlash;
uniform float uHazard;
uniform sampler2D uCrack;
`

// vUv.y is remapped at bake time to normalised cluster height, so the wipe reads
// as one continuous liquid level across every drum instead of per-cylinder.
const BARREL_FS_COLOR = `
  float fillY = smoothstep(uHp - 0.02, uHp + 0.02, vUv.y);
  vec3 body = mix(${C_HEALTHY}, ${C_DAMAGED}, fillY);

  float crack = texture2D(uCrack, vec2(vUv.x, vUv.y * 1.35)).r;
  float dmg = 1.0 - uHp;
  body *= 1.0 - crack * dmg * 0.85;

  float stripe = step(0.5, fract(vUv.x * 1.15 + vUv.y * 2.30));
  float belt = clamp(step(0.17, vUv.y) * step(vUv.y, 0.33)
                   + step(0.60, vUv.y) * step(vUv.y, 0.76), 0.0, 1.0);
  float hazard = uHazard * belt * vShell;
  body = mix(body, mix(vec3(0.02), ${C_HAZARD}, stripe), hazard);

  diffuseColor.rgb *= mix(${C_TRIM}, body, vShell);
`

const BARREL_FS_EMISSIVE = `
  // Narrower and dimmer than it looks like it should be: at 2.4 the band clips
  // under ACES and spreads into a white cap, which stops the barrel reading as
  // RED -- and red is the whole "shoot this" signal.
  float band = 1.0 - smoothstep(0.0, 0.035, abs(vUv.y - uHp));
  band *= 1.0 - smoothstep(0.95, 1.0, uHp);
  totalEmissiveRadiance += ${C_HOT} * band * (0.55 + 0.45 * uPulse) * 1.05 * vShell;
  // The about-to-blow telegraph must GLOW the barrel, not bleach it: at 0.85 a
  // half-dead drum clips to flat white under ACES and stops reading as red,
  // which is the colour the whole "shoot this" signal is carried by.
  totalEmissiveRadiance += ${C_HOT} * crack * dmg * uPulse * 0.30 * vShell;
  totalEmissiveRadiance += ${C_HAZARD} * hazard * stripe * 0.30;
  // Warm and weak, NOT white: flushDamage re-arms flash on every hit, and a
  // squad landing ~12 hits/sec against an 8/sec decay pins it near 1 forever --
  // so a full-strength white flash bleaches whichever barrel you are actually
  // shooting, which is exactly the one that must stay red.
  totalEmissiveRadiance += ${C_HOT} * uFlash * 0.30 * vShell;
`

const GLYPH_VS = `
attribute vec4 aUv;
attribute float aPop;
varying vec2 vAtlas;
void main() {
  vAtlas = aUv.xy + uv * aUv.zw;
  #include <begin_vertex>
  transformed.xy *= 1.0 + ${POP_SCALE.toFixed(3)} * aPop;
  #include <project_vertex>
}
`

const GLYPH_FS = `
uniform sampler2D uAtlas;
uniform vec3 uTint;
uniform vec3 uOutline;
uniform float uOpacity;
varying vec2 vAtlas;
void main() {
  vec4 t = texture2D(uAtlas, vAtlas);
  if (t.a < 0.02) discard;
  gl_FragColor = vec4(mix(uOutline, uTint, t.r), t.a * uOpacity);
  #include <colorspace_fragment>
}
`

const DECAL_VS = `
varying vec2 vD;
void main() {
  vD = uv;
  #include <begin_vertex>
  #include <project_vertex>
}
`

const DECAL_FS = `
uniform sampler2D uTex;
uniform float uScroll;
uniform float uAlpha;
varying vec2 vD;
void main() {
  // The plane's v = 0 edge is the one nearest the squad, so ADDING the scroll
  // walks the chevrons toward the player.
  float a = texture2D(uTex, vec2(vD.x, fract(vD.y * 2.0 + uScroll))).a;
  float edge = smoothstep(0.0, 0.16, vD.y) * (1.0 - smoothstep(0.78, 1.0, vD.y));
  gl_FragColor = vec4(${C_WARN}, a * uAlpha * edge);
  #include <colorspace_fragment>
}
`

const SHELL_VS = `
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 p = position + normal * 0.035 * sin(position.y * 5.0 + uTime * 2.4);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  // World-space normal, NOT normalMatrix: normalMatrix is model->VIEW, and
  // dotting a view-space normal with a world-space view vector gives a fresnel
  // that swims whenever the camera pans.
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const SHELL_FS = `
uniform float uBoost;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
  // Additive + fresnel saturates as the sphere shrinks: at the spawn horizon
  // almost every visible normal is grazing, so f ~ 1 across the whole disc and
  // the bubble reads as a flat white blob rather than a cyan orb -- exactly
  // where the player has to identify the reward and commit to a lane.
  vec3 c = ${C_SHELL} * (0.26 + 0.48 * f + uBoost);
  gl_FragColor = vec4(c, 0.08 + 0.34 * f);
  #include <colorspace_fragment>
}
`

const RING_VS = `
varying vec2 vR;
void main() {
  vR = uv;
  #include <begin_vertex>
  #include <project_vertex>
}
`

const RING_FS = `
uniform float uFrac;
uniform float uGlow;
varying vec2 vR;
void main() {
  // Torus uv.x sweeps counter-clockwise from +X; the mesh is rolled a quarter
  // turn, so fract(1 - uv.x) is "clockwise from 12 o'clock" -- a clock face.
  float a = fract(1.0 - vR.x);
  float k = clamp((uFrac - a) / 0.012, 0.0, 1.0);
  if (k <= 0.0) discard;
  gl_FragColor = vec4(${C_RING} * (0.72 + uGlow), k);
  #include <colorspace_fragment>
}
`

const CONTENT_VS = `
varying vec3 vN;
varying vec3 vC;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vC = color;
  #include <begin_vertex>
  #include <project_vertex>
}
`

const CONTENT_FS = `
varying vec3 vN;
varying vec3 vC;
void main() {
  // Self-contained wrap light. The reward sits inside an additive shell that is
  // brighter than anything else in the scene; letting scene lighting decide its
  // value is how the silhouette turns into a black blob at the far end.
  float key = dot(normalize(vN), normalize(vec3(0.35, 0.85, 0.42))) * 0.5 + 0.5;
  gl_FragColor = vec4(vC * (0.42 + 0.80 * key) + vec3(0.05, 0.09, 0.12), 1.0);
  #include <colorspace_fragment>
}
`

/** One cache key for every barrel, so twelve materials compile ONE program. */
function barrelCacheKey() {
  return 'aov-barrel'
}

// ------------------------------------------------------------- baked textures

/** White cracks on black. A mask, not a colour map -- it keeps the default space. */
function bakeCrackTexture() {
  const S = 256
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  ctx.strokeStyle = '#fff'
  ctx.lineCap = 'round'

  const rng = new Rng(0x5f3a91)
  for (let s = 0; s < 22; s++) {
    const x = rng.next() * S
    const y = rng.next() * S
    const ang = rng.range(-Math.PI, Math.PI)
    const segs = rng.int(4, 9)
    ctx.lineWidth = rng.range(0.9, 2.4)
    // Drawn nine times on a 3x3 lattice so the pattern wraps: the barrel repeats
    // this map across a 9-unit wall, and one seam line would read as a scratch
    // running the full width of the barricade.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        let px = x + ox * S
        let py = y + oy * S
        let a = ang
        ctx.beginPath()
        ctx.moveTo(px, py)
        for (let i = 0; i < segs; i++) {
          a += rng2(s, i) * 1.1
          px += Math.cos(a) * 14
          py += Math.sin(a) * 14
          ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
    }
  }

  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.needsUpdate = true
  return tex
}

/** Deterministic per-(stroke, segment) jitter, identical across the 3x3 lattice. */
function rng2(s, i) {
  const t = Math.sin(s * 12.9898 + i * 78.233) * 43758.5453
  return (t - Math.floor(t)) - 0.5
}

/** Alpha-only chevrons for the wall's ground warning. Also a mask, not a colour. */
function bakeChevronTexture() {
  const W = 64
  const H = 256
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 9
  ctx.lineCap = 'square'
  // Period 64 divides 256, so the strip tiles with no seam when it scrolls.
  for (let i = 0; i < 4; i++) {
    const y = i * 64 + 10
    ctx.beginPath()
    ctx.moveTo(2, y)
    ctx.lineTo(W * 0.5, y + 30)
    ctx.lineTo(W - 2, y)
    ctx.stroke()
  }
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.needsUpdate = true
  return tex
}

// ------------------------------------------------------------ geometry builders

function xform(x, y, z, rx, ry, rz, s) {
  _dummy.position.set(x, y, z)
  _dummy.rotation.set(rx, ry, rz)
  _dummy.scale.setScalar(s)
  _dummy.updateMatrix()
  return _dummy.matrix
}

/** A barrel piece. aShell = 1 for drum sheet metal, 0 for hoops and trim. */
function barrelPart(geo, m, shell) {
  const g = geo.toNonIndexed()
  g.applyMatrix4(m)
  const n = g.attributes.position.count
  const a = new Float32Array(n)
  if (shell !== 0) a.fill(shell)
  g.setAttribute('aShell', new BufferAttribute(a, 1))
  return g
}

/** A bubble-contents piece, with its colour baked per vertex. */
function contentPart(geo, m, hex) {
  const g = geo.toNonIndexed()
  g.applyMatrix4(m)
  const n = g.attributes.position.count
  const c = new Color(hex)
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r
    a[i * 3 + 1] = c.g
    a[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new BufferAttribute(a, 3))
  return g
}

function mergeParts(parts, drop) {
  const g = mergeGeometries(parts, false)
  for (let i = 0; i < parts.length; i++) parts[i].dispose()
  if (drop !== null && g.getAttribute(drop)) g.deleteAttribute(drop)
  return g
}

/**
 * Replace the merged UVs with cluster-space ones:
 *   v = normalised height, so the HP wipe spans the whole prop as one level
 *   u = world x / 1.6, so the crack map keeps a CONSTANT density on both the
 *       3.2u dodgeable cluster and the 9u wall instead of stretching 3x.
 */
function bakeClusterUv(g) {
  const pos = g.attributes.position
  const n = pos.count
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i)
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const inv = 1 / Math.max(0.001, maxY - minY)
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = pos.getX(i) / 1.6
    uv[i * 2 + 1] = (pos.getY(i) - minY) * inv
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2))
  return g
}

/**
 * A drum cluster. `uprights` and `lying` are flat [x, z, ...] tables.
 *
 * Every drum is pushed BACK in z far enough that nothing intrudes past z = +0.5,
 * because the HP plate lives at z = +0.62 and a digit half-buried in sheet metal
 * is worse than no digit at all.
 */
function buildCluster(uprights, lying, r, h, barR, barLen) {
  const drum = new CylinderGeometry(r, r, h, 16, 1)
  const hoop = new CylinderGeometry(r * 1.05, r * 1.05, 0.10, 16, 1, true)
  const bar = new CylinderGeometry(barR, barR, barLen, 12, 1)
  const barHoop = new CylinderGeometry(barR * 1.06, barR * 1.06, 0.09, 12, 1, true)
  const parts = []

  for (let i = 0; i < uprights.length; i += 2) {
    const x = uprights[i]
    const z = uprights[i + 1]
    parts.push(barrelPart(drum, xform(x, h * 0.5, z, 0, 0, 0, 1), 1))
    parts.push(barrelPart(hoop, xform(x, h * 0.26, z, 0, 0, 0, 1), 0))
    parts.push(barrelPart(hoop, xform(x, h * 0.74, z, 0, 0, 0, 1), 0))
  }
  for (let i = 0; i < lying.length; i += 3) {
    const x = lying[i]
    const y = lying[i + 1]
    const z = lying[i + 2]
    parts.push(barrelPart(bar, xform(x, y, z, 0, 0, Math.PI * 0.5, 1), 1))
    parts.push(barrelPart(barHoop, xform(x - barLen * 0.28, y, z, 0, 0, Math.PI * 0.5, 1), 0))
    parts.push(barrelPart(barHoop, xform(x + barLen * 0.28, y, z, 0, 0, Math.PI * 0.5, 1), 0))
  }

  drum.dispose()
  hoop.dispose()
  bar.dispose()
  barHoop.dispose()
  return bakeClusterUv(mergeParts(parts, null))
}

/** Three chunky figures on a ring -- readable as PEOPLE at the spawn plane. */
/**
 * The token inside a DRONE bubble.
 *
 * Deliberately the same silhouette as the real escort in src/view/drones.js --
 * square hull, four rotor discs -- because the whole job of this model is to let
 * the player recognise, from across the corridor, that the expensive lane holds
 * the thing they already have one of.
 */
function buildDroneToken() {
  const hull = new BoxGeometry(0.30, 0.085, 0.24)
  const canopy = new BoxGeometry(0.15, 0.065, 0.13)
  const podG = new CylinderGeometry(0.036, 0.036, 0.045, 6, 1)
  const discG = new CylinderGeometry(0.10, 0.10, 0.012, 10, 1)
  const parts = [
    contentPart(hull, xform(0, 0, 0, 0, 0, 0, 1), 0x55688A),
    contentPart(canopy, xform(0, 0.07, -0.02, 0, 0, 0, 1), 0x8FA6C4),
  ]
  for (let i = 0; i < 4; i++) {
    const ax = i < 2 ? -0.21 : 0.21
    const az = i % 2 === 0 ? -0.17 : 0.17
    parts.push(contentPart(podG, xform(ax, 0.03, az, 0, 0, 0, 1), 0x55688A))
    parts.push(contentPart(discG, xform(ax, 0.075, az, 0, 0, 0, 1), 0xC8D8EE))
  }
  hull.dispose()
  canopy.dispose()
  podG.dispose()
  discG.dispose()
  return mergeParts(parts, 'uv')
}

function buildSoldierTrio() {
  const body = new CylinderGeometry(0.085, 0.10, 0.26, 8, 1)
  const head = new SphereGeometry(0.075, 10, 8)
  const gun = new CylinderGeometry(0.022, 0.022, 0.24, 6, 1)
  const parts = []
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU
    const x = Math.cos(a) * 0.22
    const z = Math.sin(a) * 0.22
    parts.push(contentPart(body, xform(x, -0.05, z, 0, -a, 0, 1), 0x3E5C78))
    parts.push(contentPart(head, xform(x, 0.14, z, 0, -a, 0, 1), 0x5B7EA0))
    parts.push(contentPart(gun, xform(x + Math.cos(a) * 0.09, 0.02, z + Math.sin(a) * 0.09, Math.PI * 0.5, -a, 0, 1), 0x2A2622))
  }
  body.dispose()
  head.dispose()
  gun.dispose()
  return mergeParts(parts, 'uv')
}

/** Six-barrel silhouette. The barrel cluster is the whole read; keep it long. */
function buildMinigun() {
  const barrel = new CylinderGeometry(0.030, 0.030, 0.44, 6, 1)
  const receiver = new CylinderGeometry(0.115, 0.115, 0.22, 10, 1)
  const drum = new CylinderGeometry(0.135, 0.135, 0.085, 12, 1)
  const grip = new CylinderGeometry(0.032, 0.032, 0.20, 6, 1)
  const parts = []
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU
    parts.push(contentPart(barrel, xform(Math.cos(a) * 0.058, Math.sin(a) * 0.058, -0.30, Math.PI * 0.5, 0, 0, 1), 0x35383D))
  }
  parts.push(contentPart(receiver, xform(0, 0, 0.02, Math.PI * 0.5, 0, 0, 1), 0x4A4E55))
  parts.push(contentPart(drum, xform(0.20, 0.02, 0.10, 0, 0, Math.PI * 0.5, 1), 0x8C5A3C))
  parts.push(contentPart(grip, xform(0, -0.15, 0.14, 0.35, 0, 0, 1), 0x2A2622))
  barrel.dispose()
  receiver.dispose()
  drum.dispose()
  grip.dispose()
  return mergeParts(parts, 'uv')
}

// ----------------------------------------------------------------- glyph meshes

/**
 * A glyph strip. Position/uv are SHARED with the prototype quad -- twelve barrels
 * do not need twelve copies of four vertices -- while aUv and aPop are per-strip
 * because each strip prints its own number.
 */
function makeGlyphGeometry(proto, maxChars) {
  const g = new BufferGeometry()
  g.setIndex(proto.index)
  g.setAttribute('position', proto.attributes.position)
  g.setAttribute('uv', proto.attributes.uv)
  const uvAttr = new InstancedBufferAttribute(new Float32Array(maxChars * 4), 4)
  const popAttr = new InstancedBufferAttribute(new Float32Array(maxChars), 1)
  uvAttr.setUsage(DynamicDrawUsage)
  popAttr.setUsage(DynamicDrawUsage)
  g.setAttribute('aUv', uvAttr)
  g.setAttribute('aPop', popAttr)
  return g
}

function makeGlyphMaterial(atlasTex, tint) {
  return new ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlasTex },
      uTint: { value: tint.clone() },
      uOutline: { value: TINT_OUTLINE.clone() },
      uOpacity: { value: 1 },
    },
    vertexShader: GLYPH_VS,
    fragmentShader: GLYPH_FS,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
  })
}

function writeGlyph(atlas, arr, i, code) {
  atlas.cellUv(code, _uv)
  const o = i * 4
  arr[o] = _uv.x
  arr[o + 1] = _uv.y
  arr[o + 2] = _uv.z
  arr[o + 3] = _uv.w
}

function layoutGlyphs(mesh, n, advance, size, y, z) {
  const x0 = -((n - 1) * advance) * 0.5
  for (let i = 0; i < n; i++) {
    _pos.set(x0 + i * advance, y, z)
    _scl.set(size, size, 1)
    _mat.compose(_pos, _QI, _scl)
    mesh.setMatrixAt(i, _mat)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.count = n
}

// ------------------------------------------------------------------- the module

export function createProps(scene, atlas) {
  // Sized to the SIM's prop pool, not to the three or four typically alive. An
  // unrendered barrel is an invisible wall, which is the worst bug this module
  // could ship; invisible pool entries cost nothing per frame.
  const N = CFG.pool.props

  const root = new Group()
  root.name = 'props'
  scene.add(root)

  const geos = []
  const mats = []
  const texs = []
  const keep = (arr, x) => { arr.push(x); return x }

  const crackTex = keep(texs, bakeCrackTexture())
  const chevronTex = keep(texs, bakeChevronTexture())

  const halfNarrow = CFG.barrel.dodgeableWidth * 0.5
  const halfWall = CFG.barrel.wallWidth * 0.5
  const h = CFG.barrel.height
  const rN = 0.75
  const rW = 0.90

  const narrowGeo = keep(geos, buildCluster(
    [-(halfNarrow - rN), -0.22, halfNarrow - rN, -0.22], [0, h + 0.30, -0.30], rN, h, 0.44, 1.55))
  // Staggered z on the wall row: it reads as a barricade rather than a fence, and
  // dropping the centre drum back is what keeps the HP plate clear of it.
  const wallGeo = keep(geos, buildCluster(
    [0, -0.45, -1.8, 0.10, 1.8, 0.10, -(halfWall - rW), -0.30, halfWall - rW, -0.30],
    [-0.95, h + 0.32, -0.20, 0.95, h + 0.32, -0.20, -2.85, h + 0.32, -0.20, 2.85, h + 0.32, -0.20],
    rW, h, 0.48, 1.70))
  const decalGeo = keep(geos, new PlaneGeometry(CFG.barrel.wallWidth, 6, 1, 1).rotateX(-Math.PI * 0.5))
  const quadGeo = keep(geos, new PlaneGeometry(1, 1))
  const shellGeo = keep(geos, new IcosahedronGeometry(0.85, 2))
  const ringGeo = keep(geos, new TorusGeometry(0.93, 0.028, 6, 84))
  const trioGeo = keep(geos, buildSoldierTrio())
  const droneTokenGeo = keep(geos, buildDroneToken())
  const gunGeo = keep(geos, buildMinigun())

  const contentMat = keep(mats, new ShaderMaterial({
    uniforms: {},
    vertexShader: CONTENT_VS,
    fragmentShader: CONTENT_FS,
    vertexColors: true,
  }))

  const barrels = new Array(N)
  const bubbles = new Array(N)
  // Identity is (id, gen), not id: sim prop ids are allocated ONCE per pool slot
  // and reused forever, so a recycled slot would otherwise inherit the previous
  // barrel's pulse phase and half-finished digit pops. gen is the sim's own
  // recycling guard, bumped in the reap pass.
  const barrelId = new Int32Array(N)
  const bubbleId = new Int32Array(N)
  const barrelGen = new Int32Array(N).fill(-1)
  const bubbleGen = new Int32Array(N).fill(-1)
  const barrelUsed = new Uint8Array(N)
  const bubbleUsed = new Uint8Array(N)
  const bound = new Int32Array(N)

  for (let k = 0; k < N; k++) {
    barrels[k] = makeBarrel()
    bubbles[k] = makeBubble()
  }

  function makeBarrel() {
    const group = new Group()
    group.visible = false

    const uni = {
      uHp: { value: 1 },
      uPulse: { value: 0 },
      uFlash: { value: 0 },
      uHazard: { value: 0 },
      uCrack: { value: crackTex },
    }
    const mat = keep(mats, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.66, metalness: 0.10 }))
    // The renderer never defines USE_UV on its own since uv varyings went
    // per-map (vMapUv, vNormalMapUv...). Asking for the generic vUv explicitly is
    // what makes the fill wipe possible without binding a decoy map just to get
    // a varying back.
    mat.defines = { USE_UV: '' }
    mat.customProgramCacheKey = barrelCacheKey
    mat.onBeforeCompile = (shader) => {
      // Assign the SAME uniform objects rather than copying values: onBeforeCompile
      // runs lazily on first render, so anything written before then would be lost.
      shader.uniforms.uHp = uni.uHp
      shader.uniforms.uPulse = uni.uPulse
      shader.uniforms.uFlash = uni.uFlash
      shader.uniforms.uHazard = uni.uHazard
      shader.uniforms.uCrack = uni.uCrack
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${BARREL_VS_HEAD}`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vShell = aShell;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${BARREL_FS_HEAD}`)
        .replace('#include <color_fragment>', `#include <color_fragment>${BARREL_FS_COLOR}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${BARREL_FS_EMISSIVE}`)
    }

    const narrow = new Mesh(narrowGeo, mat)
    const wide = new Mesh(wallGeo, mat)
    wide.visible = false
    group.add(narrow, wide)

    const decalMat = keep(mats, new ShaderMaterial({
      uniforms: { uTex: { value: chevronTex }, uScroll: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: DECAL_VS,
      fragmentShader: DECAL_FS,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: FrontSide,
      // Coplanar with the road. A y-lift looks fine two metres away and z-fights
      // at the far end of the corridor -- which is the only place it is read.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }))
    const decal = new Mesh(decalGeo, decalMat)
    decal.position.set(0, 0, 3.4)
    decal.visible = false
    decal.renderOrder = 2
    group.add(decal)

    const dgeo = keep(geos, makeGlyphGeometry(quadGeo, MAX_DIGITS))
    const dmat = keep(mats, makeGlyphMaterial(atlas.texture, TINT_GOOD))
    const digits = new InstancedMesh(dgeo, dmat, MAX_DIGITS)
    // three culls an InstancedMesh against a bounding sphere at the mesh ORIGIN,
    // which knows nothing about where the instances actually are. Leave culling
    // on and the HP number silently disappears the moment the camera rolls.
    digits.frustumCulled = false
    digits.count = 0
    digits.position.set(0, DIGIT_Y, DIGIT_Z)
    digits.renderOrder = 5
    group.add(digits)

    root.add(group)
    return {
      group, narrow, wide, decal, digits, mat, uni,
      decalUni: decalMat.uniforms,
      digitUni: dmat.uniforms,
      uvAttr: dgeo.getAttribute('aUv'),
      popAttr: dgeo.getAttribute('aPop'),
      dig: new Int16Array(MAX_DIGITS),
      pop: new Float32Array(MAX_DIGITS),
      nDigits: -1,
      pulsePhase: 0,
      fresh: true,
    }
  }

  function makeBubble() {
    const group = new Group()
    group.visible = false

    const shellMat = keep(mats, new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBoost: { value: 0 } },
      vertexShader: SHELL_VS,
      fragmentShader: SHELL_FS,
      transparent: true,
      blending: AdditiveBlending,
      // FrontSide + no depth write + an explicit order. three sorts transparents
      // by object depth, which is meaningless for a shell that CONTAINS another
      // object, and DoubleSide makes the two hemispheres self-sort wrongly.
      depthWrite: false,
      side: FrontSide,
    }))
    const shell = new Mesh(shellGeo, shellMat)
    shell.renderOrder = 10
    group.add(shell)

    const ringMat = keep(mats, new ShaderMaterial({
      uniforms: { uFrac: { value: 1 }, uGlow: { value: 0 } },
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: FrontSide,
    }))
    const ring = new Mesh(ringGeo, ringMat)
    ring.rotation.z = Math.PI * 0.5
    ring.renderOrder = 9
    group.add(ring)

    const contents = new Group()
    contents.renderOrder = 0
    const trio = new Mesh(trioGeo, contentMat)
    const gun = new Mesh(gunGeo, contentMat)
    const droneToken = new Mesh(droneTokenGeo, contentMat)
    gun.visible = false
    droneToken.visible = false
    contents.add(trio, gun, droneToken)
    group.add(contents)

    const bgeo = keep(geos, makeGlyphGeometry(quadGeo, MAX_BADGE))
    const bmat = keep(mats, makeGlyphMaterial(atlas.texture, TINT_BADGE))
    const badge = new InstancedMesh(bgeo, bmat, MAX_BADGE)
    badge.frustumCulled = false
    badge.count = 0
    badge.position.y = BADGE_Y
    badge.renderOrder = 11
    group.add(badge)

    root.add(group)
    return {
      group, shell, ring, contents, trio, gun, droneToken, badge,
      shellUni: shellMat.uniforms,
      ringUni: ringMat.uniforms,
      badgeAttr: bgeo.getAttribute('aUv'),
      badgeKey: 0,
      spin: 0,
      time: 0,
    }
  }

  // ------------------------------------------------------------------ per frame

// Camera basis for the apparent-size clamp, refreshed once per sync().
let _pxK = 0
let _camX = 0, _camY = 0, _camZ = 0
let _fwdX = 0, _fwdY = 0, _fwdZ = -1

function readCameraBasis(camera) {
  if (!camera) return false
  const el = camera.matrixWorld.elements
  _fwdX = -el[8]; _fwdY = -el[9]; _fwdZ = -el[10]
  _camX = el[12]; _camY = el[13]; _camZ = el[14]
  // From the LIVE fov, not CFG.camera.fov: fov moves with the speed kick and the
  // barrel-death punch, and using the live value holds clamped text at exactly N
  // px through a punch so the number does not breathe during an explosion.
  //
  // Height in CSS px, not device px -- legibility is a physical-size question.
  // Read from CFG.derived (set on resize), never canvas.clientHeight, which
  // would force a layout flush on the frame path.
  const h = CFG.derived.canvasCssH || 900
  _pxK = (2 * Math.tan(camera.fov * Math.PI / 360)) / h
  return true
}

/** View DEPTH, not radial distance: radial is off by cos(off-axis angle). */
function viewDepth(x, y, z) {
  return (x - _camX) * _fwdX + (y - _camY) * _fwdY + (z - _camZ) * _fwdZ
}

/**
 * Scale factor that holds a quad of world size `base` at >= minPx on screen.
 * The max(_, 1) IS the floor-vs-constant distinction -- drop it and near text
 * SHRINKS to the floor.
 */
function apparentK(x, y, z, base, minPx, maxK) {
  if (_pxK <= 0) return 1
  const d = viewDepth(x, y, z)
  if (d <= 0.01) return 1
  const k = (minPx * _pxK * d) / base
  return k < 1 ? 1 : k > maxK ? maxK : k
}

  function resetBarrel(k) {
    const e = barrels[k]
    e.pulsePhase = 0
    e.nDigits = -1
    e.fresh = true
    const pop = e.popAttr.array
    for (let i = 0; i < MAX_DIGITS; i++) {
      e.dig[i] = -1
      e.pop[i] = 0
      pop[i] = 0
    }
    e.popAttr.needsUpdate = true
  }

  function resetBubble(k) {
    const e = bubbles[k]
    e.badgeKey = 0
    e.spin = 0
    e.time = 0
    e.badge.count = 0
  }

  function updateDigits(e, p, w, dt) {
    let v = Math.round(p.displayHp)
    if (v < 0) v = 0
    // The atlas has no 'k'. Wall HP peaks near 4000 at the end of a strong run,
    // so this clamp is a guard rail, not a display mode.
    if (v > 9999) v = 9999
    const n = v >= 1000 ? 4 : v >= 100 ? 3 : v >= 10 ? 2 : 1

    const uvArr = e.uvAttr.array
    let uvDirty = false
    let rest = v
    for (let i = n - 1; i >= 0; i--) {
      const d = rest % 10
      rest = (rest / 10) | 0
      if (e.dig[i] === d) continue
      e.dig[i] = d
      writeGlyph(atlas, uvArr, i, CODE_0 + d)
      // A barrel arriving at the horizon has not been shot yet; popping its
      // digits on the first frame would read as a hit that never happened.
      if (!e.fresh) e.pop[i] = POP_TIME
      uvDirty = true
    }
    if (uvDirty) e.uvAttr.needsUpdate = true
    e.fresh = false

    if (n !== e.nDigits) {
      e.nDigits = n
      // The exception to "rebuild every matrix every frame": an instance index
      // here is a DIGIT COLUMN, not a pool slot, so it cannot be reordered out
      // from under us. Layout is a pure function of the digit count, and the
      // per-frame motion lives in aPop, so re-uploading four mat4s per barrel
      // per frame would buy nothing.
      // Laid out in MESH-LOCAL space now (the mesh carries DIGIT_Y/DIGIT_Z), so
      // scaling the mesh scales the glyph PITCH and the quad extents together
      // about the string's anchor. Scaling each quad about its own origin
      // instead leaves the 0.34u pitch fixed and a 4-digit number overlaps into
      // mush at k=3.
      layoutGlyphs(e.digits, n, DIGIT_ADVANCE, DIGIT_SIZE, 0, 0)
    }

    let popDirty = false
    const popArr = e.popAttr.array
    for (let i = 0; i < MAX_DIGITS; i++) {
      if (e.pop[i] <= 0) {
        if (popArr[i] !== 0) {
          popArr[i] = 0
          popDirty = true
        }
        continue
      }
      const t = e.pop[i] - dt
      e.pop[i] = t > 0 ? t : 0
      const u = e.pop[i] / POP_TIME
      popArr[i] = u * u * (3 - 2 * u)
      popDirty = true
    }
    // Its OWN flag. Riding on instanceMatrix.needsUpdate freezes the attribute at
    // its boot values with no error -- numbers that change but never punch.
    if (popDirty) e.popAttr.needsUpdate = true

    // Green/amber/red by whether the squad can actually finish this before it
    // arrives, not by raw HP: 400hp is trivial at minute two and lethal at ten
    // seconds in.
    const scroll = w.scroll > 0.1 ? w.scroll : CFG.world.scrollStart
    const left = Math.max(0.05, (CFG.world.squadZ - p.z) / scroll)
    const ratio = (p.hp / Math.max(1, w.nominalDPS)) / left
    const tint = ratio < TTK_GOOD ? TINT_GOOD : ratio < TTK_WARN ? TINT_WARN : TINT_BAD
    e.digitUni.uTint.value.copy(tint)
  }

  function updateBarrel(k, p, w, dt) {
    const e = barrels[k]
    e.group.visible = true
    e.group.position.set(p.x, 0, p.z)

    // Uploads nothing: instanceMatrix is untouched and layoutGlyphs still only
    // runs on a digit-count change. Object3D.updateMatrixWorld picks the scale
    // up in the traversal that already runs, so this is one mat4 per prop.
    const digitZ = p.role === 'wall' ? DIGIT_Z_WALL : DIGIT_Z
    e.digits.position.z = digitZ
    e.digits.scale.setScalar(
      apparentK(p.x, DIGIT_Y, p.z + digitZ, DIGIT_SIZE, DIGIT_MIN_PX, DIGIT_MAX_K))

    const wall = p.role === 'wall'
    e.narrow.visible = !wall
    e.wide.visible = wall
    e.decal.visible = wall

    const hp = clamp(p.maxHp > 0 ? p.displayHp / p.maxHp : 0, 0, 1)
    e.uni.uHp.value = hp
    e.uni.uHazard.value = wall ? 1 : 0
    e.uni.uFlash.value = clamp(p.flash, 0, 1)

    // Integrate the PHASE, never sin(freq * t). Raising the frequency on a raw
    // time product jumps the wave every frame and the telegraph reads as a
    // rendering glitch instead of a countdown.
    e.pulsePhase += TAU * lerp(1, 6, 1 - hp) * dt
    if (e.pulsePhase > TAU) e.pulsePhase -= TAU
    e.uni.uPulse.value = 0.5 + 0.5 * Math.sin(e.pulsePhase)

    if (wall) {
      const s = e.decalUni.uScroll.value + dt * 0.9
      e.decalUni.uScroll.value = s - Math.floor(s)
      e.decalUni.uAlpha.value = remap(p.z, -58, -34, 0, 0.9) * (1 - remap(p.z, -8, 1, 0, 1))
    }

    updateDigits(e, p, w, dt)
  }

  function updateBadge(e, p, w, kind) {
    const mult = p.reward && p.reward.mult ? p.reward.mult : 1
    // roster.queueAdd clamps to the squad cap, so near 40 the raw curve value
    // would promise reinforcements that never arrive.
    const room = Math.max(0, CFG.squad.maxCount - w.count)
    const gain = Math.min(soldiersPerBubble(w.runTime) * mult, room)
    // Separate key namespaces per kind, or a drone badge and a bodies badge with
    // the same number would collide and the label would not repaint.
    const key = kind === K_WEAPON ? 1000 + w.tier
      : kind === K_DRONE ? 3000
      : 2000 + gain
    if (key === e.badgeKey) return
    e.badgeKey = key

    const arr = e.badgeAttr.array
    let n = 0
    if (kind === K_WEAPON) {
      const full = WEAPONS[w.tier + 1].name
      const name = SHORT_WORD[full] || full
      n = name.length < MAX_BADGE ? name.length : MAX_BADGE
      for (let i = 0; i < n; i++) writeGlyph(atlas, arr, i, name.charCodeAt(i))
    } else if (kind === K_DRONE) {
      // Every letter of DRONE is already in the baked atlas (the weapon names
      // needed D, R, O, N and E), so this costs no re-bake. It also needs no
      // max-tier fallback the way the weapon badge does: resolveBreaks always
      // pays a drone, so the label can never over-promise.
      const name = SHORT_WORD.DRONE
      n = name.length
      for (let i = 0; i < n; i++) writeGlyph(atlas, arr, i, name.charCodeAt(i))
    } else {
      const v = gain > 99 ? 99 : gain
      writeGlyph(atlas, arr, 0, CODE_PLUS)
      if (v >= 10) {
        writeGlyph(atlas, arr, 1, CODE_0 + ((v / 10) | 0))
        writeGlyph(atlas, arr, 2, CODE_0 + (v % 10))
        n = 3
      } else {
        writeGlyph(atlas, arr, 1, CODE_0 + v)
        n = 2
      }
    }
    e.badgeAttr.needsUpdate = true
    layoutGlyphs(e.badge, n, BADGE_ADVANCE, BADGE_SIZE, 0, 0)
  }

  function updateBubble(k, p, w, dt, camera) {
    const e = bubbles[k]
    e.group.visible = true
    e.group.position.set(p.x, CFG.bubble.y, p.z)

    e.time += dt
    e.shellUni.uTime.value = e.time
    e.shellUni.uBoost.value = clamp(p.flash, 0, 1) * 0.9

    e.ringUni.uFrac.value = clamp(p.maxHp > 0 ? p.displayHp / p.maxHp : 0, 0, 1)
    e.ringUni.uGlow.value = clamp(p.flash, 0, 1)

    // At max tier the sim pays a weapon bubble out in bodies, so the badge and
    // the model both have to say bodies -- promising a gun it cannot deliver is
    // the one lie the reward layer must never tell.
    //
    // KIND, not a boolean. A drone bubble used to fall into the `else` here and
    // was drawn as the soldier trio with a "+N soldiers" badge it never paid --
    // the exact lie the rule above forbids, and the reason the pickup was
    // invisible: it looked identical to the cheap lane beside it while costing
    // 2.3x as much, so it was strictly the dominated choice.
    const r = p.reward
    const kind = r === null ? K_BODIES
      : r.type === 'weapon' && w.tier < MAX_TIER ? K_WEAPON
      : r.type === 'drone' ? K_DRONE
      : K_BODIES
    e.gun.visible = kind === K_WEAPON
    e.droneToken.visible = kind === K_DRONE
    e.trio.visible = kind === K_BODIES

    e.spin += 0.7 * dt
    if (e.spin > TAU) e.spin -= TAU
    e.contents.rotation.y = e.spin
    e.contents.position.y = Math.sin(e.time * Math.PI) * 0.085

    if (camera !== null) e.badge.quaternion.copy(camera.quaternion)
    // Compose order is T*R*S, so the scale and the billboard quaternion do not
    // fight. layoutGlyphs already centres the badge at local (0,0), and
    // badge.position.y carries BADGE_Y, so the mesh origin IS the string anchor.
    const badgeK = apparentK(p.x, CFG.bubble.y + BADGE_Y, p.z, BADGE_SIZE, BADGE_MIN_PX, BADGE_MAX_K)
    e.badge.scale.setScalar(badgeK)
    updateBadge(e, p, w, kind)
  }

  /**
   * `sync(w, dt, camera)` per this module's brief, `sync(w, dt, alpha, camera)`
   * per the view contract. Sniffing for isCamera costs two comparisons and makes
   * the module correct under either caller.
   */
  function sync(w, dt, a, b) {
    const camera = b && b.isCamera ? b : a && a.isCamera ? a : null
    const step = dt > 0 ? dt : 0

    // Once per frame, and AFTER applyInterpolation has run (see main.js render
    // order): deriving k from an un-interpolated z makes the size step at 60Hz
    // on a 120Hz panel, a visible stutter on the one element the eye is on.
    readCameraBasis(camera)

    for (let k = 0; k < N; k++) {
      barrelUsed[k] = 0
      bubbleUsed[k] = 0
    }

    const pool = w.props
    const n = pool.size

    // Pass 1: props keep the entry that already owns their id. Pool indices are
    // NOT stable across frames (swap-remove), so binding by index would swap a
    // barrel's pulse phase and digit-pop state with its neighbour's the instant
    // anything died.
    for (let i = 0; i < n; i++) {
      const p = pool.items[i]
      bound[i] = -1
      // Gates share the prop pool but are drawn by src/view/gates.js. Without
      // this skip they fall through the barrel test and are rendered as bubbles.
      if (p.kind === 'gate') continue
      const isBarrel = p.kind === 'barrel'
      const ids = isBarrel ? barrelId : bubbleId
      const gens = isBarrel ? barrelGen : bubbleGen
      const used = isBarrel ? barrelUsed : bubbleUsed
      for (let k = 0; k < N; k++) {
        if (used[k] === 0 && ids[k] === p.id && gens[k] === p.gen) {
          used[k] = 1
          bound[i] = k
          break
        }
      }
    }

    // Pass 2: anything new takes a free entry and wipes its animation state.
    for (let i = 0; i < n; i++) {
      if (bound[i] >= 0) continue
      const p = pool.items[i]
      if (p.kind === 'gate') continue
      const isBarrel = p.kind === 'barrel'
      const ids = isBarrel ? barrelId : bubbleId
      const gens = isBarrel ? barrelGen : bubbleGen
      const used = isBarrel ? barrelUsed : bubbleUsed
      for (let k = 0; k < N; k++) {
        if (used[k] !== 0) continue
        used[k] = 1
        ids[k] = p.id
        gens[k] = p.gen
        bound[i] = k
        if (isBarrel) resetBarrel(k)
        else resetBubble(k)
        break
      }
    }

    for (let i = 0; i < n; i++) {
      const k = bound[i]
      if (k < 0) continue
      const p = pool.items[i]
      if (p.kind === 'barrel') updateBarrel(k, p, w, step)
      else updateBubble(k, p, w, step, camera)
    }

    for (let k = 0; k < N; k++) {
      if (barrelUsed[k] === 0) {
        barrels[k].group.visible = false
        barrelGen[k] = -1
      }
      if (bubbleUsed[k] === 0) {
        bubbles[k].group.visible = false
        bubbleGen[k] = -1
      }
    }
  }

  function reset() {
    for (let k = 0; k < N; k++) {
      barrelGen[k] = -1
      bubbleGen[k] = -1
      barrels[k].group.visible = false
      bubbles[k].group.visible = false
      resetBarrel(k)
      resetBubble(k)
    }
  }

  function dispose() {
    scene.remove(root)
    for (let i = 0; i < geos.length; i++) geos[i].dispose()
    for (let i = 0; i < mats.length; i++) mats[i].dispose()
    for (let i = 0; i < texs.length; i++) texs[i].dispose()
    geos.length = 0
    mats.length = 0
    texs.length = 0
  }

  reset()
  return { sync, reset, dispose }
}
