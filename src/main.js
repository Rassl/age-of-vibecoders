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
import { createImmersive } from './xr/immersive.js'
import { bus, T } from './core/bus.js'
import { createWorld, STATE, MODE } from './sim/world.js'
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
import { createTurret } from './view/turret.js'
import { createTracers } from './fx/tracers.js'
import { createParticles } from './fx/particles.js'
import { createRings } from './fx/rings.js'
import { createMelons } from './fx/melons.js'
import { createDamageNumbers } from './fx/damagenumbers.js'
import { createLabels } from './view/labels.js'
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

// One 2K (1K on coarse pointers) shadow map, owned by the corridor's key light.
// Set before any view builds a material so nothing needs a needsUpdate pass.
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const world = createWorld((Math.random() * 0x7fffffff) | 0)

const atlas = createGlyphAtlas()
const corridor = createCorridor(scene)
const cameraRig = createCameraRig(camera)
const characters = createCharacters(scene)
const props = createProps(scene, atlas)
const gates = createGates(scene, atlas)
const drones = createDrones(scene)
const turret = createTurret(scene)
// particles BEFORE tracers: the muzzle-smoke wisp is a dependency, not a lookup.
const particles = createParticles(scene)
const tracers = createTracers(scene, { particles })
const rings = createRings(scene)
const melons = createMelons(scene)
const decals = createDecals(scene)
const debris = createDebris(scene)
const damage = createDamageNumbers(scene, atlas)
const labels = createLabels(scene, atlas)
const projectiles = createProjectiles(scene)
// A composer, not a layer: it owns no mesh and no frame callback, it just keeps
// one six-call recipe from drifting across the eight sites that fire it.
const blasts = createBlasts({ particles, rings, tracers, decals, debris, damage })
const hud = createHud(hudRoot)
const audio = createAudio()

// Sound toggle: master-gain mute, remembered across sessions.
const SND_KEY = 'aov-muted'
let sndMuted = false
try { sndMuted = localStorage.getItem(SND_KEY) === '1' } catch { }
audio.setMuted(sndMuted)
hud.soundButton(sndMuted, () => {
  sndMuted = !sndMuted
  audio.setMuted(sndMuted)
  try { localStorage.setItem(SND_KEY, sndMuted ? '1' : '0') } catch { }
  return sndMuted
})

// Pause: stop the rAF loop (the last frame stays up) and suspend the audio
// context. resync() on resume, or the stopped span lands in the accumulator
// as one giant dt.
let gamePaused = false
const pauseBtn = hud.pauseButton(() => {
  gamePaused = !gamePaused
  if (gamePaused) {
    loop.stop()
    audio.suspend()
  } else {
    loop.resync()
    loop.start()
    audio.resume()
  }
  return gamePaused
})

const input = new Input(canvas)

const overlay = createOverlay(overlayRoot, onStart, onRestart, onReplay)

// ------------------------------------------------------------- NG+ rounds ---
// One completed run unlocks the next round; each round raises CFG.difficulty,
// which curves.js applies to obstacle pricing (horde, barrels, boss). Rewards
// and the safety caps are untouched, so a harder round squeezes the budget
// rather than rigging the dice. Persisted so the loop survives a reload;
// storage is best-effort -- a blocked localStorage just means every session
// starts at round 1.
const ROUND_KEY = 'aov-round'
const DIFFICULTY_PER_ROUND = 0.15

function loadRound() {
  try {
    const r = parseInt(localStorage.getItem(ROUND_KEY), 10)
    return Number.isFinite(r) && r >= 1 ? Math.min(r, 99) : 1
  } catch { return 1 }
}

let round = loadRound()

/**
 * The round cycles the run mode: ADVANCE down the corridor (the original
 * game), then HOLD the line -- the squad plants, the road stops, and the
 * horde walks in -- then MAN THE GUN: the drag aims a mounted turret and the
 * squad drives itself (sim/world.js MODE, director.js, sim/autopilot.js).
 *
 * `?mode=advance|hold|turret` pins a mode for the session regardless of
 * round, so any of the three can be played or tested without winning two
 * rounds first. Difficulty still follows the round.
 */
const MODE_CYCLE = [MODE.ADVANCE, MODE.HOLDOUT, MODE.TURRET]
const MODE_NAME = ['ADVANCE', 'HOLD', 'TURRET']
const MODE_PARAM = { advance: MODE.ADVANCE, hold: MODE.HOLDOUT, holdout: MODE.HOLDOUT, turret: MODE.TURRET }

function forcedMode() {
  try {
    const m = new URLSearchParams(location.search).get('mode')
    return m && MODE_PARAM[m.toLowerCase()] !== undefined ? MODE_PARAM[m.toLowerCase()] : -1
  } catch { return -1 }
}

function roundMode() {
  const forced = forcedMode()
  return forced >= 0 ? forced : MODE_CYCLE[(round - 1) % MODE_CYCLE.length]
}

function applyRound() {
  CFG.difficulty = 1 + DIFFICULTY_PER_ROUND * (round - 1)
  overlay.setRound(round, roundMode())
}
applyRound()

// The renderer drives the frame loop (not raw rAF) so that an immersive WebXR
// session can take it over: XR frames exist only inside the session's callback.
const loop = new Loop(step, render, beforeStep, {
  start: (fn) => renderer.setAnimationLoop(fn),
  stop: () => renderer.setAnimationLoop(null),
})

wireReactions({ loop, camera: cameraRig, particles, tracers, rings, hud, audio, world, blasts, turret })

let endCardTimer = 0
let runGeneration = 0

bus.on(T.RUN_OVER, (e) => {
  // Let the death beat land before the card interrupts it -- but if the player
  // has already restarted by then, the queued card must not pop over a live run.
  const gen = runGeneration
  const won = e.a === 1
  if (won) {
    // Advance BEFORE the card shows: the end card announces the next round,
    // and the next restart() prices against it. Applied here, not in restart(),
    // so retrying a lost round replays the same difficulty.
    round++
    try { localStorage.setItem(ROUND_KEY, String(round)) } catch { /* best-effort */ }
    applyRound()
  }
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

/**
 * Replay the round just won instead of advancing. RUN_OVER already bumped the
 * round and persisted it, so step it back BEFORE restart() prices the run.
 */
function onReplay() {
  if (round > 1) {
    round--
    try { localStorage.setItem(ROUND_KEY, String(round)) } catch { /* best-effort */ }
    applyRound()
  }
  onRestart()
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
  // A retry from a paused end screen must come back RUNNING: un-pause first
  // or the new run starts into a stopped loop and a stale play icon.
  if (gamePaused) {
    gamePaused = false
    pauseBtn.set(false)
    loop.start()
  }
  startRun(world, (Math.random() * 0x7fffffff) | 0, roundMode())
  bus.clear()
  loop.clearHitstop()
  loop.resync()
  input.reset()
  corridor.reset()
  cameraRig.reset(world)
  characters.reset()
  props.reset()
  gates.reset()
  drones.reset()
  turret.reset()
  tracers.reset()
  particles.reset()
  rings.reset()
  melons.reset()
  decals.reset()
  debris.reset()
  damage.reset()
  labels.reset()
  projectiles.reset()
  hud.reset()
  audio.reset()
}

input.onRestart = () => {
  if (world.state === STATE.WON || world.state === STATE.LOST) onRestart()
}

// ---------------------------------------------------------- immersive view ---

const xr = createImmersive({
  renderer, scene, camera, world, input, onStart, onRestart,
  onEnter() { audio.resume() },
  onExit() {
    // Back on the flat screen: the rig snaps the camera to its pose and the
    // canvas is re-fitted (setSize is refused while presenting).
    cameraRig.reset(world)
    resize()
  },
})
const xrBtn = hud.xrButton(() => { xr.enter() })
xr.supported().then((ok) => xrBtn.show(ok))

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
  // The pinch-drag is read here, inside the XR frame, before the drain.
  if (xr.presenting) xr.poll()
  pendingDx += input.drainDx()
  // Sampled once per frame so every substep of that frame agrees on the
  // direction; a key released mid-frame must not steer for half of it.
  heldAxis = input.axis()
  steppedThisFrame = false
}

function step(dt, nSubsteps) {
  // Mark the frame as having consumed pendingDx. render() clears the accumulator
  // only when this is set; without it the delta is re-applied on every substep of
  // every subsequent frame and one flick walks the squad into the rail.
  steppedThisFrame = true
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

  // In a headset the head is the camera: the rig only moves the platform.
  if (xr.presenting) xr.sync(world, rawDt)
  else cameraRig.sync(world, rawDt, scaledDt, alpha)
  corridor.sync(world, rawDt)
  characters.sync(world, rawDt, camera)
  props.sync(world, rawDt, camera)
  gates.sync(world, rawDt, camera)
  drones.sync(world, rawDt)
  turret.sync(world, rawDt)
  rings.sync(world, rawDt)
  melons.sync(world)
  decals.sync(world, rawDt)
  debris.sync(world, rawDt)
  projectiles.sync(world, rawDt, camera)
  tracers.sync(world, rawDt, camera)
  particles.sync(rawDt, camera)
  damage.sync(world, rawDt, camera)
  labels.sync(world, rawDt, camera)
  hud.sync(world)
  audio.setIntensity(Math.min(1, world.count / CFG.squad.intensityRef))
  audio.sync(rawDt, world)

  const t0 = performance.now()
  if (import.meta.env && import.meta.env.DEV) window.__drawDistance = world.distance
  renderer.render(scene, camera)
  restoreInterpolation(world, interpolated)
  if (!xr.presenting) governDPR(performance.now() - t0)
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
  // The XR layer owns the framebuffer while presenting; three refuses setSize.
  if (xr.presenting) return
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
    // Groups too, not just meshes: a barrel cluster is a visible mesh inside an
    // INVISIBLE group, so opening only meshes leaves its program uncompiled --
    // and the compile stall then lands on the first explosion instead of here.
    if (!o.isMesh && !o.isPoints && !o.isLine) {
      if (o.visible === false) {
        restore.push([o, o.visible, undefined])
        o.visible = true
      }
      return
    }
    restore.push([o, o.visible, o.count, o.frustumCulled])
    o.visible = true
    // Pooled meshes are parked outside the camera AND the shadow frustum, so a
    // visible-only warm-up still never draws them; culling off for this one
    // frame is what actually forces every program -- depth pass included.
    o.frustumCulled = false
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
    const [o, vis, count, culled] = restore[i]
    o.visible = vis
    if (culled !== undefined) o.frustumCulled = culled
    if (o.isInstancedMesh) o.count = count
  }
}

startRun(world, world.seed, roundMode())
// The loop runs so the corridor renders behind the start card, but the sim is
// held in READY -- otherwise an unplayed attract run ticks at full speed and can
// reach zero soldiers, replacing the start card with a game-over card.
world.state = STATE.READY
// The attract frame must already sit behind the right camera: a turret round
// that opened on the corridor pose would dolly across the road on deploy.
cameraRig.reset(world)
prewarmShaders()
overlay.showStart()
loop.start()

if (import.meta.env && import.meta.env.DEV) {
  // Dev-only round/mode switcher (bottom-left). Dynamic import inside this
  // statically-false-in-prod guard, so the module never reaches the build.
  import('./ui/devlevel.js').then(({ createDevLevel }) => {
    createDevLevel({
      round: () => round,
      label: () => `R${round} · ${MODE_NAME[roundMode()]}`,
      set(r) {
        round = Math.max(1, Math.min(99, r))
        try { localStorage.setItem(ROUND_KEY, String(round)) } catch { /* best-effort */ }
        applyRound()
        // Mid-run (or on an end card): hot-restart straight into the new
        // round. On the title card, just retag it -- deploy stays a tap.
        if (world.state !== STATE.READY) {
          overlay.hide()
          restart()
        }
      },
    })
  })

  window.__game = { world, CFG, loop, renderer, scene, camera, bus, T,
    views: { cameraRig, corridor, characters, props, gates, drones, turret, rings, decals, debris, projectiles, tracers, particles, damage, hud } }
}
