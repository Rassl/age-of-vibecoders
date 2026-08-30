/**
 * Boot and frame orchestration.
 *
 * The render half of the tick order lives here; the simulation half lives in
 * src/sim/systems.js. Nothing below writes sim state -- after runStep() the
 * frame is strictly read-only over the world.
 */
import * as THREE from 'three'

import { CFG, deriveConfig, validateConfig } from './config.js'
import { Loop } from './core/loop.js'
import { Input } from './core/input.js'
import { bus, T } from './core/bus.js'
import { createWorld, STATE } from './sim/world.js'
import { startRun } from './sim/run.js'
import { runStep } from './sim/systems.js'
import { applyInterpolation, restoreInterpolation } from './sim/interpolate.js'
import { wireReactions } from './reactions.js'

import { createCorridor } from './view/corridor.js'
import { createCameraRig } from './view/camera.js'
import { createCharacters } from './view/characters.js'
import { createGlyphAtlas } from './view/atlas.js'
import { createProps } from './view/props.js'
import { createGates } from './view/gates.js'
import { createDrones } from './view/drones.js'
import { createTracers } from './fx/tracers.js'
import { createParticles } from './fx/particles.js'
import { createRings } from './fx/rings.js'
import { createDamageNumbers } from './fx/damagenumbers.js'
import { createDecals } from './fx/decals.js'
import { createDebris } from './fx/debris.js'
import { createBlasts } from './fx/blasts.js'
import { createProjectiles } from './fx/projectiles.js'
import { createHud } from './ui/hud.js'
import { createOverlay } from './ui/overlay.js'
import { createAudio } from './audio/audio.js'

const canvas = document.getElementById('game-canvas')
const stage = document.getElementById('stage')
const hudRoot = document.getElementById('hud')
const overlayRoot = document.getElementById('overlay')

// --------------------------------------------------------------- renderer ---

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: window.devicePixelRatio <= 1.5,
  powerPreference: 'high-performance',
  stencil: false,
})
renderer.outputColorSpace = THREE.SRGBColorSpace
// ACES from day one: turning tone mapping on later means re-picking every colour.
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.setClearColor(0x5c6b7a)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(CFG.camera.fov, 1, CFG.camera.near, CFG.camera.far)

// ------------------------------------------------------------------ views ---

deriveConfig(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight)
validateConfig()

const world = createWorld((Math.random() * 0x7fffffff) | 0)

const atlas = createGlyphAtlas()
const corridor = createCorridor(scene)
const cameraRig = createCameraRig(camera)
const characters = createCharacters(scene)
const props = createProps(scene, atlas)
const gates = createGates(scene, atlas)
const drones = createDrones(scene)
// particles BEFORE tracers: the muzzle-smoke wisp is a dependency, not a lookup.
const particles = createParticles(scene)
const tracers = createTracers(scene, { particles })
const rings = createRings(scene)
const decals = createDecals(scene)
const debris = createDebris(scene)
const damage = createDamageNumbers(scene, atlas)
const projectiles = createProjectiles(scene)
// A composer, not a layer: it owns no mesh and no frame callback, it just keeps
// one six-call recipe from drifting across the eight sites that fire it.
const blasts = createBlasts({ particles, rings, tracers, decals, debris, damage })
const hud = createHud(hudRoot)
const audio = createAudio()

const input = new Input(canvas)

const overlay = createOverlay(overlayRoot, onStart, onRestart)

const loop = new Loop(step, render, beforeStep)

wireReactions({ loop, camera: cameraRig, particles, tracers, rings, hud, audio, world, blasts })

let endCardTimer = 0
let runGeneration = 0

bus.on(T.RUN_OVER, (e) => {
  // Let the death beat land before the card interrupts it -- but if the player
  // has already restarted by then, the queued card must not pop over a live run.
  const gen = runGeneration
  const won = e.a === 1
  clearTimeout(endCardTimer)
  endCardTimer = setTimeout(() => {
    if (gen === runGeneration) overlay.showEnd(world, won)
  }, 900)
})

// ------------------------------------------------------------- run states ---

function onStart() {
  audio.resume()
  overlay.hide()
  restart()
  loop.start()
}

function onRestart() {
  // resume() is the only thing that boots the AudioContext. If the player's
  // first gesture of the session lands here rather than on the start card, the
  // whole run would otherwise be silent.
  audio.resume()
  overlay.hide()
  restart()
}

/**
 * Instant restart: no scene teardown, no disposal, no reload. One frame.
 * Frictionless retry IS the retention mechanic of this genre.
 */
function restart() {
  runGeneration++
  clearTimeout(endCardTimer)
  startRun(world, (Math.random() * 0x7fffffff) | 0)
  bus.clear()
  loop.clearHitstop()
  loop.resync()
  input.reset()
  corridor.reset()
  cameraRig.reset()
  characters.reset()
  props.reset()
  gates.reset()
  drones.reset()
  tracers.reset()
  particles.reset()
  rings.reset()
  decals.reset()
  debris.reset()
  damage.reset()
  projectiles.reset()
  hud.reset()
  audio.reset()
}

input.onRestart = () => {
  if (world.state === STATE.WON || world.state === STATE.LOST) onRestart()
}

// ----------------------------------------------------------------- frames ---

/**
 * ACCUMULATE the drag; do not assign it.
 *
 * A frame whose accumulator has not yet reached one fixed step runs zero
 * substeps, so nothing consumes pendingDx -- and assigning here would throw that
 * frame's finger movement away. On a 144Hz display that is 58% of all input, and
 * it also fires throughout every hitstop (scaledDt is tiny, so several frames in
 * a row step zero times), which reads as the squad going dead right after a
 * barrel explodes.
 */
function beforeStep() {
  pendingDx += input.drainDx()
  // Sampled once per frame so every substep of that frame agrees on the
  // direction; a key released mid-frame must not steer for half of it.
  heldAxis = input.axis()
  steppedThisFrame = false
}

function step(dt, nSubsteps) {
  // The drag delta is drained once per FRAME and divided EVENLY across substeps:
  // dumping it into substep 0 would let the per-substep speed cap truncate a
  // fast flick on exactly the hitching frames where control matters most. The
  // axis is NOT divided -- it is a direction, and it applies whole to each.
  runStep(world, dt, pendingDx / nSubsteps, heldAxis)
}

let pendingDx = 0
let heldAxis = 0
let steppedThisFrame = false

function render(rawDt, scaledDt, alpha, frameMs) {
  // The substeps between them consumed exactly pendingDx; a frame that stepped
  // zero times carries its delta forward instead of losing it.
  if (steppedThisFrame) pendingDx = 0

  // Drain ONCE per frame: a 3-substep frame would otherwise fire three explosion
  // bursts for what the player perceives as one event.
  bus.drain()

  // Draw the world eased between sim steps, then hand the true values back.
  const interpolated = applyInterpolation(world, alpha)

  cameraRig.sync(world, rawDt, scaledDt, alpha)
  corridor.sync(world, rawDt)
  characters.sync(world, rawDt, camera)
  props.sync(world, rawDt, camera)
  gates.sync(world, rawDt, camera)
  drones.sync(world, rawDt)
  rings.sync(world, rawDt)
  decals.sync(world, rawDt)
  debris.sync(world, rawDt)
  projectiles.sync(world, rawDt, camera)
  tracers.sync(world, rawDt, camera)
  particles.sync(rawDt, camera)
  damage.sync(world, rawDt, camera)
  hud.sync(world)
  audio.setIntensity(Math.min(1, world.count / CFG.squad.maxCount))
  audio.sync(rawDt, world)

  const t0 = performance.now()
  if (import.meta.env && import.meta.env.DEV) window.__drawDistance = world.distance
  renderer.render(scene, camera)
  restoreInterpolation(world, interpolated)
  governDPR(performance.now() - t0)
}

// The real ceiling in this build is FILL RATE, not entity count, and DPR 2 on a
// retina portrait viewport is ~4M fragments/frame. Downshift only, with
// hysteresis -- an oscillating resolution is more noticeable than a soft one.
//
// It governs on RENDER COST, never on the frame period: a display or power mode
// capped at 30Hz has a 33ms period on every frame no matter how cheap the scene
// is, and would walk the resolution straight down to the floor for nothing.
const DPR_STEPS = [2.0, 1.5, 1.25, 1.0]
let dprIndex = 0
let slowFrames = 0

function governDPR(renderMs) {
  if (renderMs <= CFG.perf.dprDownshiftMs) { slowFrames = 0; return }
  if (++slowFrames < CFG.perf.dprDownshiftFrames) return
  slowFrames = 0
  if (dprIndex >= DPR_STEPS.length - 1) return
  dprIndex++
  applyDPR()
}

function applyDPR() {
  const cap = CFG.derived.isMobile ? CFG.perf.pixelRatioMobile : CFG.perf.pixelRatioDesktop
  // Start below any step the cap already covers, so the first downshift always
  // actually buys fill rate instead of resolving to the same pixel ratio.
  while (dprIndex < DPR_STEPS.length - 1 && DPR_STEPS[dprIndex] >= cap) dprIndex++
  const target = Math.min(window.devicePixelRatio || 1, cap, DPR_STEPS[dprIndex])
  renderer.setPixelRatio(target)
}

// ----------------------------------------------------------------- resize ---

/**
 * Letterbox to a portrait stage.
 *
 * A 9-unit corridor viewed in a 16:10 window leaves most of the screen as empty
 * desert with the squad as a speck. Rather than distort the tuned framing, the
 * play area is a centred portrait rect and the surround is inert.
 */
const STAGE_MIN_ASPECT = 0.46   // tallest we go (a very tall phone)
const STAGE_MAX_ASPECT = 0.72   // widest before we letterbox

function resize() {
  const winW = window.innerWidth
  const winH = window.innerHeight
  const target = Math.min(Math.max(winW / winH, STAGE_MIN_ASPECT), STAGE_MAX_ASPECT)

  let w = winW
  let h = Math.round(winW / target)
  if (h > winH) { h = winH; w = Math.round(winH * target) }

  stage.style.width = w + 'px'
  stage.style.height = h + 'px'

  deriveConfig(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h, false)
  applyDPR()
}

window.addEventListener('resize', resize)
window.addEventListener('orientationchange', resize)
resize()

/**
 * Compile every shader before the first frame the player sees.
 *
 * three compiles a material lazily the first time it is actually rendered, so
 * the debut of each effect -- the first barrel explosion, the first damage
 * number, the first decal -- costs a compile on the frame it appears. Measured
 * as a 427ms hitch and a stack of 60ms frames, exactly where the action is.
 *
 * Pooled meshes sit at count 0 / visible false, and the compiler skips those, so
 * everything is forced briefly visible for one compile pass and then restored.
 */
function prewarmShaders() {
  const restore = []
  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return
    restore.push([o, o.visible, o.count])
    o.visible = true
    if (o.isInstancedMesh && o.count === 0) o.count = 1
  })
  try {
    renderer.compile(scene, camera)
    renderer.render(scene, camera)
  } catch (err) {
    // A warm-up failure must never stop the game booting.
    console.warn('shader prewarm skipped:', err && err.message)
  }
  for (let i = 0; i < restore.length; i++) {
    const [o, vis, count] = restore[i]
    o.visible = vis
    if (o.isInstancedMesh) o.count = count
  }
}

startRun(world, world.seed)
// The loop runs so the corridor renders behind the start card, but the sim is
// held in READY -- otherwise an unplayed attract run ticks at full speed and can
// reach zero soldiers, replacing the start card with a game-over card.
world.state = STATE.READY
prewarmShaders()
overlay.showStart()
loop.start()

if (import.meta.env && import.meta.env.DEV) {
  window.__game = { world, CFG, loop, renderer, scene, camera,
    views: { cameraRig, corridor, characters, props, gates, drones, rings, decals, debris, projectiles, tracers, particles, damage, hud } }
}
