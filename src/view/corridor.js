/**
 * The corridor: sand, road, railings, sky, fog, and the two lights that model it.
 *
 * This module owns the sensation of SPEED, and in this genre speed is carried by
 * the RAILINGS, not by the road. A scrolling asphalt texture is nearly invisible
 * at a 15 degree camera pitch; a post whipping past at 6.4Hz is unmissable.
 * Everything else here exists to keep that one signal legible -- the fog wall so
 * the spawn horizon has somewhere to emerge from, the side props so the eye
 * cannot catch the treadmill repeating, the light direction so a box has three
 * distinct face values without a single shadow map.
 *
 * EVERY transform is a pure function of `w.distance`. Nothing integrates its own
 * scroll from dt: a private integrator drifts against the sim within seconds and,
 * worse, survives resetWorld() -- restart would snap the entities back to the
 * horizon while the road kept its old phase.
 *
 * Nothing here is shootable. The sim knows about zombies, barrels and bubbles; it
 * does not know a rock exists. So every prop is placed OUTSIDE the railings: a
 * rock inside them is a promise the simulation cannot keep.
 */
import {
  BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  DirectionalLight, DodecahedronGeometry, FogExp2, Group, HemisphereLight,
  InstancedMesh, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry,
  RepeatWrapping, ShaderMaterial, SphereGeometry, SRGBColorSpace, Vector3,
} from 'three'
import { createScenery } from './scenery.js'
import { CFG } from '../config.js'
import { remap } from '../util/math.js'

// STATE.BOSS. Duplicated rather than imported: the view never imports from sim/,
// and this is the only sim enum the corridor reads.
const STATE_BOSS = 2

// -------------------------------------------------------------------- palette
// Materials carry the hue; vertex colours and instance colours are always grey
// VALUE multipliers on top of it, so a retint is one hex per surface.

const C_SAND = 0xc2a878
// Darker than it was (0x9c968a): the road is the ground every body stands on,
// and a mid-grey road put the squad and the horde at its own value. Pulling it
// down a step is what lets a saturated blue and red carry the read at 60u.
const C_ASPHALT = 0x60666b
const C_STRIPE = 0xd8cba6
const C_STEEL = 0x87959d
const C_RUST = 0x8c5a3c
const C_ROCK = 0x8e7c60
const C_BARRIER = 0xb9ae96
const C_WRECK = 0x6a5348
const C_BLOCK = 0xa2957c

const C_FOG = 0xd9c39b
const C_HORIZON = 0xe0c9a0
const C_SKY_TOP = 0x5c6b7a
const C_HEMI_SKY = 0xbfd8ff
const C_HEMI_GND = 0xc89b62
const C_KEY = 0xffe7c2

// Boss approach. The sky top goes toward the boss's violet so the finale is
// foreshadowed by the world rather than announced by the HUD.
const C_GLOW = 0xffd9a0        // dusk lobe + sun disc down the corridor
const C_RIDGE_A = 0x6e6053     // near mountain layer, darker than the sand
const C_RIDGE_B = 0x8c7d68     // far layer, drifting toward the fog

const C_FOG_HOT = 0xc27a52
const C_HORIZON_HOT = 0xe08a52
const C_SKY_TOP_HOT = 0x3e2c3a
const C_HEMI_SKY_HOT = 0x8a5a6e
const C_HEMI_GND_HOT = 0x8c4030
const C_KEY_HOT = 0xff7a4a
const C_GLOW_HOT = 0xff6a38
const C_RIDGE_A_HOT = 0x4a3038
const C_RIDGE_B_HOT = 0x6e4438
const DANGER_LEAD = 10   // seconds of corridor over which the light turns

// --------------------------------------------------------------------- layout

// Recycle stride. NOT 40 or 56: at the mid-run 16 u/s those tick over in exactly
// 2.5s and 3.5s, and a seam that lands on the same phase every time strobes even
// though each individual wrap is invisible. 54.6 shares no clean ratio with the
// 14 -> 18 u/s scroll ramp.
const DASH_PERIOD = 4.2
const DASHES_PER_TILE = 13
const TILE_LEN = DASH_PERIOD * DASHES_PER_TILE   // 54.6 -- a whole number of dash
const TILE_COUNT = 4                             // periods, or dashes break at the seam
const DASH_LEN = 2.3
const DASH_HALF_W = 0.11
const EDGE_LINE_X = 4.12
const EDGE_LINE_HALF_W = 0.09

const BEHIND_MARGIN = 8   // wrap plane sits this far behind CFG.world.despawnZ
const SAND_Y = -0.06      // a real embankment step, not a coplanar y-lift: the road
                          // is the reference plane and nothing may float above it

// 2.2u at the 14 u/s start speed is 6.36 posts/second -- fast enough to read as
// speed, slow enough that the eye still resolves one post from the next.
const POST_SPACING = 2.2
const POSTS_PER_SIDE = 55
const POST_H = 1.02
const BEAM_LEN = 132
const BEAM_Z = -50

const ROCKS_PER_TILE = 8
const LARGE_PER_TILE = 5
const ROCK_CAP = TILE_COUNT * ROCKS_PER_TILE
const BOX_CAP = TILE_COUNT * LARGE_PER_TILE * 2   // a wreck costs two boxes

const SKY_RADIUS = 150    // inside camera.far (200) from the dolly's furthest pose

// ------------------------------------------------------- module-scope scratch
// Hoisted so that sync() allocates nothing. A GC sawtooth in a 60fps runner is
// felt as input lag and gets misdiagnosed as a control problem.
const _c = new Color()
const _cA = new Color()
const _cB = new Color()

/** Deterministic hash of two ints -> [0,1). Props are a pure function of tile ordinal. */
function hash2(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h ^ (h >>> 7), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/**
 * Write one translate/yaw/scale matrix straight into an instanceMatrix buffer.
 * Column-major, ~12 flops instead of Object3D.updateMatrix()'s full quaternion
 * path, and it skips the copy that setMatrixAt() would do.
 */
function composeYaw(arr, o, x, y, z, yaw, sx, sy, sz) {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  arr[o] = c * sx; arr[o + 1] = 0; arr[o + 2] = -s * sx; arr[o + 3] = 0
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0
  arr[o + 8] = s * sz; arr[o + 9] = 0; arr[o + 10] = c * sz; arr[o + 11] = 0
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1
}

/** Instance tint = palette colour scaled by a per-instance value factor. */
function writeTint(arr, i, col, v) {
  const o = i * 3
  arr[o] = col.r * v
  arr[o + 1] = col.g * v
  arr[o + 2] = col.b * v
}

// ------------------------------------------------------------ boot-time bakes

/** Grey value-noise into a plane's vertex colours so the sand is not one dead flat tone. */
function bakeSandValue(geo) {
  const pos = geo.attributes.position
  const n = pos.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const v = 0.90 + 0.20 * hash2(Math.round(pos.getX(i) * 0.06), Math.round(pos.getZ(i) * 0.06))
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v
  }
  geo.setAttribute('color', new BufferAttribute(col, 3))
}

/**
 * Wheel-wear bands into the road's vertex colours. Constant along z, so it is
 * invisible at the tile seams while still breaking the flat slab lengthwise.
 */
function bakeRoadWear(geo) {
  const pos = geo.attributes.position
  const n = pos.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(pos.getX(i))
    const v = ax > 1.8 && ax < 2.8 ? 0.90 : ax > 4.0 ? 1.06 : 1.0
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v
  }
  geo.setAttribute('color', new BufferAttribute(col, 3))
}

function writeVert(pos, col, i, x, z, shade) {
  const o = i * 3
  pos[o] = x; pos[o + 1] = 0; pos[o + 2] = z
  col[o] = shade; col[o + 1] = shade; col[o + 2] = shade
}

/** One +Y-facing quad in the XZ plane, two triangles, wound CCW from above. */
function quad(pos, col, i, x0, x1, z0, z1, shade) {
  writeVert(pos, col, i + 0, x0, z0, shade)
  writeVert(pos, col, i + 1, x0, z1, shade)
  writeVert(pos, col, i + 2, x1, z1, shade)
  writeVert(pos, col, i + 3, x0, z0, shade)
  writeVert(pos, col, i + 4, x1, z1, shade)
  writeVert(pos, col, i + 5, x1, z0, shade)
  return i + 6
}

/** Edge lines plus one tile's worth of centre dashes, as a single flat geometry. */
function buildMarkingsGeometry() {
  const verts = (2 + DASHES_PER_TILE) * 6
  const pos = new Float32Array(verts * 3)
  const col = new Float32Array(verts * 3)
  const nor = new Float32Array(verts * 3)
  const half = TILE_LEN * 0.5
  let i = 0
  // Edge lines run dimmer than the dashes: worn paint at the kerb, and it keeps
  // the centre line the brightest thing on the road.
  i = quad(pos, col, i, -EDGE_LINE_X - EDGE_LINE_HALF_W, -EDGE_LINE_X + EDGE_LINE_HALF_W, -half, half, 0.78)
  i = quad(pos, col, i, EDGE_LINE_X - EDGE_LINE_HALF_W, EDGE_LINE_X + EDGE_LINE_HALF_W, -half, half, 0.78)
  for (let k = 0; k < DASHES_PER_TILE; k++) {
    const zc = -half + DASH_PERIOD * (k + 0.5)
    i = quad(pos, col, i, -DASH_HALF_W, DASH_HALF_W, zc - DASH_LEN * 0.5, zc + DASH_LEN * 0.5, 1.0)
  }
  for (let v = 0; v < verts; v++) nor[v * 3 + 1] = 1

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('normal', new BufferAttribute(nor, 3))
  geo.setAttribute('color', new BufferAttribute(col, 3))
  return geo
}

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// The bottom stop is EXACTLY the fog colour. Any difference at all and the fog
// line stops reading as distance and starts reading as a wall across the level.
// On top of the gradient: a low sun straight down the corridor (the vanishing
// point is where the eye already lives, so that is where the light goes), and
// two trig cirrus bands so the upper third is not a dead flat field.
const SKY_FRAG = `
#include <common>
#include <dithering_pars_fragment>
uniform vec3 uFog;
uniform vec3 uHorizon;
uniform vec3 uTop;
uniform vec3 uGlow;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  vec3 c = mix(uFog, uHorizon, smoothstep(0.0, 0.10, h));
  c = mix(c, uTop, smoothstep(0.13, 0.85, h));

  // Cirrus streaks: long in azimuth, thin in elevation. Applied before the sun
  // lobe so the glow sits over the clouds, not under them.
  float a = atan(dir.x, -dir.z);
  float band = sin(h * 34.0 + a * 2.1 + 1.3) * sin(h * 13.0 - a * 3.7 + 0.6);
  float cl = smoothstep(0.015, 0.06, h) * smoothstep(0.55, 0.16, h);
  c = mix(c, mix(uTop, uHorizon, 0.60), cl * max(band, 0.0) * 0.35);

  // Dusk lobe low over the vanishing point, plus the disc itself. The disc adds
  // rather than mixes: under ACES that is what lets it read as LIGHT.
  float sunAmt = max(dot(dir, uSunDir), 0.0);
  float lobe = pow(sunAmt, 5.0) * smoothstep(0.40, 0.0, abs(h - 0.05));
  c += uGlow * lobe * 0.50;
  c += uGlow * smoothstep(0.99930, 0.99975, sunAmt) * 1.5;

  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`

// ------------------------------------------------------- procedural surfaces

/**
 * Tileable grayscale detail texture: per-pixel speckle plus soft blotches, the
 * blotches stamped on a 3x3 lattice so the wrap has no seam. Values live in
 * [lo, hi] out of 255 -- a pure VALUE multiplier under the material colour, so
 * the palette stays one hex per surface.
 */
function makeDetailTexture(seed, lo, hi, blotches, darkA, lightA) {
  const SZ = 128
  const cv = document.createElement('canvas')
  cv.width = SZ
  cv.height = SZ
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(SZ, SZ)
  const px = img.data
  for (let i = 0; i < SZ * SZ; i++) {
    const v = lo + (hi - lo) * hash2(seed, i)
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  for (let b = 0; b < blotches; b++) {
    const x = SZ * hash2(seed + 1, b)
    const y = SZ * hash2(seed + 2, b)
    const r = SZ * (0.06 + 0.14 * hash2(seed + 3, b))
    const dark = hash2(seed + 4, b) < 0.6
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const g = ctx.createRadialGradient(x + ox * SZ, y + oy * SZ, 0, x + ox * SZ, y + oy * SZ, r)
      g.addColorStop(0, dark ? `rgba(0,0,0,${darkA})` : `rgba(255,255,255,${lightA})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(x + ox * SZ - r, y + oy * SZ - r, r * 2, r * 2)
    }
  }
  const tex = new CanvasTexture(cv)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

// Mean multiplier of a [205, 255] speckle in linear space; the material colour
// is scaled back up by 1/this so the detail map changes texture, not exposure.
const DETAIL_MEAN = 0.795

/**
 * One ridge line of overlapping fog-hazed triangles: distant mesas. Cardboard
 * on purpose -- at 100u+ inside FogExp2 all that survives is silhouette, and a
 * silhouette is one triangle, not a mesh.
 */
function buildRidgeGeometry(seed, span, baseH) {
  const positions = [], colors = []
  // Each peak has three sloping faces and a projecting foothill, so sunlight
  // describes a volume instead of a flat triangle pasted onto the sky.
  for (let k = 0; k < 30; k++) {
    const cx = -span + 2 * span * ((k + .5) / 30)
    const w = span / 30 * (1.6 + 2.6 * hash2(seed, k + 7))
    const h = baseH * (.30 + .95 * hash2(seed, k + 3))
    const apex = cx + (hash2(seed, k + 5) - .5) * w * .8
    const peak = [apex, h, -3 - hash2(seed, k + 9) * 9]
    const foot = [cx + w * .15, 0, 8 + hash2(seed, k + 12) * 8]
    const left = [cx - w, 0, 0], right = [cx + w, 0, 0]
    for (const [a, b, c, shade] of [[left, foot, peak, .87], [foot, right, peak, 1.12]]) {
      positions.push(...a, ...b, ...c)
      for (const v of [a, b, c]) {
        const value = shade * (v[1] > 0 ? 1.10 : .88)
        colors.push(value, value, value)
      }
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.computeVertexNormals()
  return geo
}

/**
 * Build the world the player runs down.
 * @param {import('three').Scene} scene
 */
export function createCorridor(scene) {
  const group = new Group()
  const geos = []
  const mats = []

  const own = (mesh) => {
    geos.push(mesh.geometry)
    mats.push(mesh.material)
    group.add(mesh)
    return mesh
  }

  // ------------------------------------------------------------------ fog + sky
  const fog = new FogExp2(C_FOG, CFG.fx.fogDensity)
  const prevFog = scene.fog
  scene.fog = fog

  // Drawn first and writing no depth: the sand plane runs past camera.far and gets
  // clipped, and the dome has to be the thing behind the hole rather than in front
  // of it. dithering because a dusk gradient across a portrait screen bands badly.
  const skyMat = new ShaderMaterial({
    uniforms: {
      uFog: { value: new Color(C_FOG) },
      uHorizon: { value: new Color(C_HORIZON) },
      uTop: { value: new Color(C_SKY_TOP) },
      uGlow: { value: new Color(C_GLOW) },
      // Slightly left of the vanishing point, matching the key's azimuth side,
      // and LOW: the disc half-sets behind the ridge line instead of floating
      // in the dead centre of the sky band.
      uSunDir: { value: new Vector3(-0.12, 0.055, -1.0).normalize() },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    fog: false,
    dithering: true,
  })
  const sky = new Mesh(new SphereGeometry(SKY_RADIUS, 32, 20), skyMat)
  sky.renderOrder = -1
  sky.frustumCulled = false
  own(sky)

  // ------------------------------------------------------------------ lighting
  // Two lights, no shadow maps. With flat boxes the light DIRECTION is the entire
  // modelling budget: a 40 degree key from the upper left front gives every box a
  // lit face, a mid face and a dark face. A top-down key would flatten the whole
  // scene into one unreadable value.
  const hemi = new HemisphereLight(C_HEMI_SKY, C_HEMI_GND, 0.72)
  const key = new DirectionalLight(C_KEY, 1.15)
  key.position.set(-39.5, 38.6, 23.0)
  group.add(hemi, key, key.target)

  // Cool sky-bounce from behind the horde. Diffuse-only backlight cannot rim a
  // silhouette, but it does put a value step on every shoulder and skull top,
  // which is what separates a fogged crowd from a fogged road.
  const rim = new DirectionalLight(0x9db8ff, 0.40)
  rim.position.set(16.0, 22.0, -38.0)
  group.add(rim, rim.target)

  // The key carries the ONE shadow map. Frustum hugs the playfield plus the
  // near shoulder props; everything further is fogged too hard for a shadow to
  // read anyway. Sized by pointer class, and the DPR governor still owns the
  // overall fill budget.
  key.castShadow = true
  const shadowSize = CFG.derived.isMobile ? 1024 : 2048
  key.shadow.mapSize.set(shadowSize, shadowSize)
  key.target.position.set(0, 0, -16)
  const sc = key.shadow.camera
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34
  sc.near = 15; sc.far = 130
  // Flat-shaded boxes acne along their own faces at grazing key angles;
  // normalBias pushes the sample off the surface without peter-panning feet.
  key.shadow.bias = -0.00015
  key.shadow.normalBias = 0.06

  // -------------------------------------------------------------------- ground
  // One static plane: uniform sand has no features, so scrolling it would be work
  // nobody can see. All motion lives in the road markings, posts and props.
  const sandGeo = new PlaneGeometry(360, 460, 18, 24)
  sandGeo.rotateX(-Math.PI / 2)
  sandGeo.translate(0, SAND_Y, -150)
  bakeSandValue(sandGeo)
  const sandTex = makeDetailTexture(7, 205, 255, 26, 0.10, 0.08)
  sandTex.repeat.set(48, 60)
  const sandMat = new MeshLambertMaterial({ color: C_SAND, vertexColors: true, map: sandTex })
  sandMat.color.multiplyScalar(1 / DETAIL_MEAN)
  const sand = new Mesh(sandGeo, sandMat)
  sand.receiveShadow = true
  own(sand)

  // ---------------------------------------------------------------- mountains
  // Two static silhouette layers behind the fog wall. No parallax on purpose:
  // at 100u+ the camera's 2u of lateral travel moves them under a pixel, and
  // integrating a scroll for them is drift risk for zero visible motion.
  const ridgeMatA = new MeshLambertMaterial({ color: C_RIDGE_A, vertexColors: true })
  const ridgeMatB = new MeshLambertMaterial({ color: C_RIDGE_B, vertexColors: true })
  const ridgeA = new Mesh(buildRidgeGeometry(3, 150, 11), ridgeMatA)
  ridgeA.position.set(0, SAND_Y, -104)
  const ridgeB = new Mesh(buildRidgeGeometry(11, 190, 15), ridgeMatB)
  ridgeB.position.set(28, SAND_Y, -132)
  ridgeA.frustumCulled = false
  ridgeB.frustumCulled = false
  own(ridgeB)
  own(ridgeA)

  // ---------------------------------------------------------- road + markings
  const roadGeo = new PlaneGeometry(CFG.world.corridorWidth, TILE_LEN, 8, 1)
  roadGeo.rotateX(-Math.PI / 2)
  bakeRoadWear(roadGeo)
  // Whole repeats per tile in both axes, or the speckle seams at the recycle.
  const roadTex = makeDetailTexture(23, 205, 255, 14, 0.05, 0.04)
  roadTex.repeat.set(3, 18)
  const roadMat = new MeshLambertMaterial({ color: C_ASPHALT, vertexColors: true, map: roadTex })
  roadMat.color.multiplyScalar(1 / DETAIL_MEAN)
  const road = new InstancedMesh(roadGeo, roadMat, TILE_COUNT)
  road.frustumCulled = false
  road.receiveShadow = true
  own(road)

  // polygonOffset, never a y-lift: a lift looks correct near the camera and
  // z-fights at the far end of the corridor, which is exactly where the player
  // is reading. Every other coplanar layer in the game shares these numbers.
  const markMat = new MeshLambertMaterial({
    color: C_STRIPE,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  const marks = new InstancedMesh(buildMarkingsGeometry(), markMat, TILE_COUNT)
  marks.frustumCulled = false
  marks.receiveShadow = true
  own(marks)

  // ------------------------------------------------------------------ railings
  const steelMat = new MeshLambertMaterial({ color: C_STEEL })
  const postGeo = new BoxGeometry(0.13, POST_H, 0.13)
  postGeo.translate(0, POST_H * 0.5, 0)   // origin at the base: instances sit at y = 0
  const posts = new InstancedMesh(postGeo, steelMat, POSTS_PER_SIDE * 2)
  posts.frustumCulled = false
  posts.castShadow = true
  own(posts)

  // Rust every 3rd post, keyed on the post's WORLD ordinal, so the 2.1Hz sub-beat
  // survives recycling. Key it on the instance index instead and the stripes crawl.
  const stripeGeo = new BoxGeometry(0.17, 0.24, 0.17)
  stripeGeo.translate(0, 0.58, 0)
  const stripes = new InstancedMesh(stripeGeo, new MeshLambertMaterial({ color: C_RUST }), POSTS_PER_SIDE)
  stripes.frustumCulled = false
  own(stripes)

  // The top and mid rails are deliberately featureless, which is what lets them be
  // static: a continuous beam has nothing on it that could betray that it is not
  // moving, and any repeating detail added here would strobe.
  const beams = new InstancedMesh(new BoxGeometry(0.16, 0.11, BEAM_LEN), steelMat, 4)
  beams.frustumCulled = false
  own(beams)

  const railX = CFG.world.railX
  const bm = beams.instanceMatrix.array
  composeYaw(bm, 0, -railX, 0.96, BEAM_Z, 0, 1, 1, 1)
  composeYaw(bm, 16, railX, 0.96, BEAM_Z, 0, 1, 1, 1)
  composeYaw(bm, 32, -railX, 0.52, BEAM_Z, 0, 1, 1, 1)
  composeYaw(bm, 48, railX, 0.52, BEAM_Z, 0, 1, 1, 1)
  beams.instanceMatrix.needsUpdate = true
  beams.count = 4

  // ---------------------------------------------------------------- side props
  const rockGeo = new DodecahedronGeometry(0.5, 0)
  const rocks = new InstancedMesh(rockGeo, new MeshLambertMaterial({ color: 0xffffff }), ROCK_CAP)
  rocks.frustumCulled = false
  rocks.castShadow = true
  rocks.receiveShadow = true
  own(rocks)

  const boxGeo = new BoxGeometry(1, 1, 1)
  boxGeo.translate(0, 0.5, 0)
  const boxes = new InstancedMesh(boxGeo, new MeshLambertMaterial({ color: 0xffffff }), BOX_CAP)
  boxes.frustumCulled = false
  boxes.castShadow = true
  boxes.receiveShadow = true
  own(boxes)

  // setColorAt() lazily allocates the attribute, so prime both here at boot --
  // never on the frame that first needs a tint.
  _c.setHex(0xffffff, SRGBColorSpace)
  for (let i = 0; i < ROCK_CAP; i++) rocks.setColorAt(i, _c)
  for (let i = 0; i < BOX_CAP; i++) boxes.setColorAt(i, _c)

  const COL_ROCK = new Color(C_ROCK)
  const COL_BARRIER = new Color(C_BARRIER)
  const COL_WRECK = new Color(C_WRECK)
  const COL_BLOCK = new Color(C_BLOCK)

  const scenery = createScenery(group)
  scene.add(group)

  // -------------------------------------------------------------- danger shift
  const FOG_COOL = new Color(C_FOG), FOG_HOT = new Color(C_FOG_HOT)
  const HOR_COOL = new Color(C_HORIZON), HOR_HOT = new Color(C_HORIZON_HOT)
  const TOP_COOL = new Color(C_SKY_TOP), TOP_HOT = new Color(C_SKY_TOP_HOT)
  const HS_COOL = new Color(C_HEMI_SKY), HS_HOT = new Color(C_HEMI_SKY_HOT)
  const HG_COOL = new Color(C_HEMI_GND), HG_HOT = new Color(C_HEMI_GND_HOT)
  const KEY_COOL = new Color(C_KEY), KEY_HOT = new Color(C_KEY_HOT)
  const GLOW_COOL = new Color(C_GLOW), GLOW_HOT = new Color(C_GLOW_HOT)
  const RA_COOL = new Color(C_RIDGE_A), RA_HOT = new Color(C_RIDGE_A_HOT)
  const RB_COOL = new Color(C_RIDGE_B), RB_HOT = new Color(C_RIDGE_B_HOT)
  const DANGER_MAX = 0.42
  let dangerApplied = -1

  function applyDanger(k) {
    // Fog and the dome's bottom stop are written from the SAME colour, always.
    fog.color.lerpColors(FOG_COOL, FOG_HOT, k)
    skyMat.uniforms.uFog.value.copy(fog.color)
    skyMat.uniforms.uHorizon.value.lerpColors(HOR_COOL, HOR_HOT, k)
    skyMat.uniforms.uTop.value.lerpColors(TOP_COOL, TOP_HOT, k)
    hemi.color.lerpColors(HS_COOL, HS_HOT, k)
    hemi.groundColor.lerpColors(HG_COOL, HG_HOT, k)
    key.color.lerpColors(KEY_COOL, KEY_HOT, k)
    key.intensity = 1.15 + 0.25 * k
    skyMat.uniforms.uGlow.value.lerpColors(GLOW_COOL, GLOW_HOT, k)
    ridgeMatA.color.lerpColors(RA_COOL, RA_HOT, k)
    ridgeMatB.color.lerpColors(RB_COOL, RB_HOT, k)
    dangerApplied = k
  }
  applyDanger(0)

  /**
   * @param {object} w world state, read-only.
   * dt/alpha/camera are accepted by the pipeline and ignored here: every
   * transform below is a pure function of w.distance, which is what makes a
   * restart snap to the right phase instead of easing into it.
   */
  function sync(w) {
    const d = w.distance
    scenery.sync(d)
    const wrapZ = CFG.world.despawnZ + BEHIND_MARGIN
    const rx = CFG.world.railX

    // ---- tiles, and the props that ride on them ----
    // floor() puts the nearest tile centre at or beyond the wrap plane, so the
    // road never runs out in front of the camera at an unlucky phase.
    const n0 = Math.floor((d - wrapZ) / TILE_LEN)
    const tm = road.instanceMatrix.array
    const mm = marks.instanceMatrix.array
    const rm = rocks.instanceMatrix.array
    const rc = rocks.instanceColor.array
    const xm = boxes.instanceMatrix.array
    const xc = boxes.instanceColor.array
    let rockN = 0
    let boxN = 0

    for (let j = 0; j < TILE_COUNT; j++) {
      const n = n0 + j
      const z = d - n * TILE_LEN
      composeYaw(tm, j * 16, 0, 0, z, 0, 1, 1, 1)
      composeYaw(mm, j * 16, 0, 0, z, 0, 1, 1, 1)

      const z0 = z - TILE_LEN * 0.5

      for (let k = 0; k < ROCKS_PER_TILE; k++) {
        if (rockN >= ROCK_CAP) break
        const s = 0.5 + 1.6 * hash2(n, k) * hash2(n, k + 11)
        const sy = s * (0.55 + 0.45 * hash2(n, k + 23))
        // Nearest x is 6.4, so even a max-size rock stays 0.8u outside the 4.5
        // railing. Anything that crosses that line reads as a target, and the sim
        // has no idea this object exists.
        const x = (hash2(n, k + 37) < 0.5 ? -1 : 1) * (6.4 + 9.0 * hash2(n, k + 41))
        composeYaw(rm, rockN * 16, x, SAND_Y + 0.30 * sy, z0 + TILE_LEN * hash2(n, k + 53),
          6.2832 * hash2(n, k + 59), s, sy, s)
        writeTint(rc, rockN, COL_ROCK, 0.82 + 0.36 * hash2(n, k + 61))
        rockN++
      }

      for (let k = 0; k < LARGE_PER_TILE; k++) {
        if (boxN + 2 > BOX_CAP) break
        const pick = hash2(n, k + 101)
        const side = hash2(n, k + 103) < 0.5 ? -1 : 1
        const x = side * (8.0 + 10.0 * hash2(n, k + 107))
        const pz = z0 + TILE_LEN * hash2(n, k + 109)
        const v = 0.84 + 0.32 * hash2(n, k + 113)
        if (pick < 0.42) {
          // barrier: nearly corridor-aligned, so it reinforces the vanishing point
          composeYaw(xm, boxN * 16, x, SAND_Y, pz, (hash2(n, k + 127) - 0.5) * 0.24, 0.42, 1.0, 3.4)
          writeTint(xc, boxN, COL_BARRIER, v)
          boxN++
        } else if (pick < 0.78) {
          // wreck: body plus cabin at one shared yaw. Two boxes, not one, because
          // the step in the silhouette is the whole reason it reads as a car.
          const yaw = 6.2832 * hash2(n, k + 131)
          composeYaw(xm, boxN * 16, x, SAND_Y, pz, yaw, 2.0, 0.95, 4.4)
          writeTint(xc, boxN, COL_WRECK, v)
          boxN++
          composeYaw(xm, boxN * 16, x + Math.sin(yaw) * 0.45, SAND_Y + 0.95, pz + Math.cos(yaw) * 0.45,
            yaw, 1.7, 0.72, 1.9)
          writeTint(xc, boxN, COL_WRECK, v * 0.82)
          boxN++
        } else {
          const s = 1.1 + 0.7 * hash2(n, k + 137)
          composeYaw(xm, boxN * 16, x, SAND_Y, pz, 6.2832 * hash2(n, k + 139), s, s * 0.9, s)
          writeTint(xc, boxN, COL_BLOCK, v)
          boxN++
        }
      }
    }

    road.instanceMatrix.needsUpdate = true
    road.count = TILE_COUNT
    marks.instanceMatrix.needsUpdate = true
    marks.count = TILE_COUNT
    rocks.instanceMatrix.needsUpdate = true
    // Its OWN flag. Riding on instanceMatrix.needsUpdate freezes every tint at
    // its boot value while the props keep moving -- silently, with no error.
    rocks.instanceColor.needsUpdate = true
    rocks.count = rockN
    boxes.instanceMatrix.needsUpdate = true
    boxes.instanceColor.needsUpdate = true
    boxes.count = boxN

    // ---- railing posts ----
    const pm = posts.instanceMatrix.array
    const sm = stripes.instanceMatrix.array
    const m0 = Math.ceil((d - wrapZ) / POST_SPACING)
    let stripeN = 0
    for (let k = 0; k < POSTS_PER_SIDE; k++) {
      const m = m0 + k
      const z = d - m * POST_SPACING
      composeYaw(pm, k * 32, -rx, 0, z, 0, 1, 1, 1)
      composeYaw(pm, k * 32 + 16, rx, 0, z, 0, 1, 1, 1)
      if (m % 3 === 0 && stripeN + 2 <= POSTS_PER_SIDE) {
        composeYaw(sm, stripeN * 16, -rx, 0, z, 0, 1, 1, 1)
        composeYaw(sm, stripeN * 16 + 16, rx, 0, z, 0, 1, 1, 1)
        stripeN += 2
      }
    }
    posts.instanceMatrix.needsUpdate = true
    posts.count = POSTS_PER_SIDE * 2
    stripes.instanceMatrix.needsUpdate = true
    stripes.count = stripeN

    // ---- lighting ----
    // Derived, never integrated: the ramp is already at 1 when the state flips, so
    // the handoff is continuous, and a restart is back to dusk on the same frame.
    const danger = w.state === STATE_BOSS
      ? 1
      : remap(w.runTime, CFG.world.runSeconds - DANGER_LEAD, CFG.world.runSeconds, 0, 1)
    // Capped well below 1: at full strength the shift stops being a mood and
    // becomes a red filter -- soldiers crush to black silhouettes and the boss
    // loses its violet, i.e. the two things the player most needs to read.
    const capped = Math.min(danger, DANGER_MAX)
    if (capped !== dangerApplied) applyDanger(capped)
  }

  /** Restart. Everything else is derived from w.distance and needs no rewind. */
  function reset() {
    applyDanger(0)
  }

  function dispose() {
    scenery.dispose()
    scene.remove(group)
    sandTex.dispose()
    roadTex.dispose()
    if (scene.fog === fog) scene.fog = prevFog
    for (let i = 0; i < geos.length; i++) geos[i].dispose()
    for (let i = 0; i < mats.length; i++) mats[i].dispose()
    geos.length = 0
    mats.length = 0
  }

  return { sync, reset, dispose }
}
