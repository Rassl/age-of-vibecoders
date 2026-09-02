/**
 * The mounted gun of TURRET mode, and its laser sight.
 *
 * ONE object the player owns with their thumb, drawn large in the foreground
 * of a camera that otherwise sits behind it: a pedestal, a yawing cradle, a
 * receiver with an ammo can hanging off its left side, and a six-barrel
 * cluster that spins up under fire. Every number the gun needs to agree with
 * the simulation about -- the pivot, the barrel length, the bore height --
 * is read from CFG.turret, and the yaw itself is read from `w.turretYaw`, the
 * SAME angle combat.fireTurret cast the ray along. The gun cannot point
 * anywhere the bullets did not go.
 *
 * The laser is the aim readout, not decoration: it runs from the muzzle to
 * wherever the last turret ray actually stopped (w.turretHitX/Z), so the beam
 * shortens onto a barrel the moment a barrel is in the way, and the ground
 * reticle at its end is where the damage is landing. A reticle at a fixed
 * distance would lie every time a body walked into the line.
 *
 * SIX DRAW CALLS, none instanced: base, yawing body, barrel cluster, beam core,
 * beam glow, reticle. No shadow: the key light would throw the whole gun as
 * one blob across the road under the camera, which reads as a hole in the
 * ground, not as grounding. Hidden outside TURRET mode; prewarmShaders still
 * compiles it because it opens invisible groups.
 *
 * Read-only over `w`. Writes nothing back, ever.
 */
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color,
  CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, TorusGeometry, Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CFG } from '../config.js'
import { clamp, damp } from '../util/math.js'

// Mirrors MODE.TURRET in sim/world.js. The view never imports from sim/.
const MODE_TURRET = 2

const TAU = Math.PI * 2

// Palette. Value gradients are baked per part; hue is one hex per surface.
// Lighter than they look in isolation: the gun sits in the darkest part of
// the frame under ACES, and a true gunmetal reads as a silhouette there.
const C_GUNMETAL = 0x6a7079
const C_STEEL = 0x9d978a
const C_DARK = 0x3e4248
const C_OLIVE = 0x6b6a3e
const C_BRASS = 0xc9a24a
const C_RUBBER = 0x2a2622
const C_LASER = 0xff3a2e

// Recoil spring: stiff and fairly damped, so at 12 rounds/s the receiver
// shudders on its trunnions rather than swinging.
const RECOIL_OMEGA = 34
const RECOIL_ZETA = 0.42
const RECOIL_KICK = 1.6
const RECOIL_GAIN = 0.045        // world units of setback at drive 1
const MAX_SPRING_STEP = 0.033

// Barrel cluster spin-up. Rate is rad/s at full heat.
const SPIN_RATE = 30
const HEAT_RISE = 0.06           // s
const HEAT_FALL = 0.55           // s

// Beam widths in world units at the muzzle; the glow is the fake bloom.
const BEAM_CORE_W = 0.045
const BEAM_GLOW_W = 0.24
const RETICLE_R = 0.62
const HIT_Y = 0.85               // chest height: where the ray reads as landing

// Render-side yaw lag. The sim already low-passes the aim; this only hides the
// 60Hz staircase on a 120Hz panel, and must stay well under one substep.
const YAW_TAU = 0.025

// Module scratch. sync() allocates nothing.
const _a = new Vector3()
const _b = new Vector3()
const _col = new Color()

/** Bake a vertical value gradient + one hue into a primitive's vertex colours. */
function paint(geo, hex, y0, y1) {
  const pos = geo.attributes.position
  const n = pos.count
  const col = new Float32Array(n * 3)
  _col.setHex(hex)
  const span = Math.max(1e-3, y1 - y0)
  for (let i = 0; i < n; i++) {
    const k = 0.72 + 0.28 * clamp((pos.getY(i) - y0) / span, 0, 1)
    col[i * 3] = _col.r * k
    col[i * 3 + 1] = _col.g * k
    col[i * 3 + 2] = _col.b * k
  }
  geo.setAttribute('color', new BufferAttribute(col, 3))
  return geo
}

const box = (w, h, d) => new BoxGeometry(w, h, d)
const cyl = (rt, rb, h, seg) => new CylinderGeometry(rt, rb, h, seg)

/** Cylinder along -Z (authored along Y), centred at (x, y, z). */
function tube(r, len, seg, x, y, z) {
  return cyl(r, r, len, seg).rotateX(Math.PI / 2).translate(x, y, z)
}

/**
 * Two crossed quads, unit long along Z. Same reasoning as the tracer streak:
 * a single quad goes edge-on to this camera, a box double-adds where its own
 * faces overlap.
 */
function buildStreak() {
  const p = new Float32Array([
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5,
    -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
    0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5,
    0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5,
  ])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(p, 3))
  return g
}

function additive(hex) {
  return new MeshBasicMaterial({
    color: hex, blending: AdditiveBlending, transparent: true, depthWrite: false,
    fog: false, toneMapped: false, side: DoubleSide,
  })
}

export function createTurret(scene) {
  const t = CFG.turret
  const BORE_Y = t.muzzleY
  const L = t.barrelLen

  const root = new Group()
  root.position.set(0, 0, t.z)
  root.visible = false

  const lit = new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x0c0e12 })

  // ---- base: pedestal + column. Static; the yaw happens above it. ----------
  const baseGeo = mergeGeometries([
    paint(cyl(0.64, 0.70, 0.16, 14).translate(0, 0.08, 0), C_DARK, 0, 0.16),
    paint(cyl(0.18, 0.22, BORE_Y - 0.55, 10).translate(0, (BORE_Y - 0.55) * 0.5 + 0.16, 0), C_STEEL, 0.16, BORE_Y - 0.4),
    // Three bolt heads around the plate: a base that is fixed to something.
    paint(box(0.10, 0.06, 0.10).translate(0.46, 0.19, 0.20), C_STEEL, 0.16, 0.22),
    paint(box(0.10, 0.06, 0.10).translate(-0.46, 0.19, 0.20), C_STEEL, 0.16, 0.22),
    paint(box(0.10, 0.06, 0.10).translate(0, 0.19, -0.48), C_STEEL, 0.16, 0.22),
  ], false)
  const base = new Mesh(baseGeo, lit)
  root.add(base)

  // ---- yawing body: cradle, trunnions, receiver, ammo can, grips ----------
  const yaw = new Group()
  root.add(yaw)

  // The receiver rides the recoil spring; the cradle under it does not.
  const recoil = new Group()
  yaw.add(recoil)

  const cradleY = BORE_Y - 0.42
  const cradleGeo = mergeGeometries([
    paint(box(0.60, 0.12, 0.38).translate(0, cradleY, 0), C_GUNMETAL, cradleY - 0.06, cradleY + 0.06),
    paint(box(0.08, 0.40, 0.30).translate(0.27, cradleY + 0.22, 0), C_GUNMETAL, cradleY, cradleY + 0.42),
    paint(box(0.08, 0.40, 0.30).translate(-0.27, cradleY + 0.22, 0), C_GUNMETAL, cradleY, cradleY + 0.42),
    // Trunnion pins, the pivot the recoil reads against.
    paint(cyl(0.06, 0.06, 0.74, 8).rotateZ(Math.PI / 2).translate(0, BORE_Y - 0.06, 0.02), C_STEEL, BORE_Y - 0.12, BORE_Y),
  ], false)
  const cradle = new Mesh(cradleGeo, lit)
  yaw.add(cradle)

  const beltParts = []
  for (let i = 0; i < 6; i++) {
    const u = i / 5
    // Rounds arc up out of the can and into the left of the receiver.
    const x = -0.44 + 0.22 * u
    const y = BORE_Y - 0.10 + 0.22 * Math.sin(u * Math.PI)
    const z = 0.06 - 0.10 * u
    beltParts.push(paint(box(0.05, 0.035, 0.11).translate(x, y, z), C_BRASS, y - 0.02, y + 0.02))
  }

  const bodyGeo = mergeGeometries([
    // Receiver, bore height, running back to the spade grips.
    paint(box(0.36, 0.30, 1.05).translate(0, BORE_Y - 0.02, -0.12), C_GUNMETAL, BORE_Y - 0.17, BORE_Y + 0.13),
    // Top cover and a rear sight post: the silhouette break that says "gun".
    paint(box(0.14, 0.06, 0.52).translate(0, BORE_Y + 0.16, -0.20), C_DARK, BORE_Y + 0.13, BORE_Y + 0.19),
    paint(box(0.03, 0.10, 0.03).translate(0, BORE_Y + 0.24, 0.10), C_DARK, BORE_Y + 0.19, BORE_Y + 0.29),
    // Ammo can, olive, hung off the left with its feed chute into the side.
    paint(box(0.30, 0.38, 0.46).translate(-0.42, BORE_Y - 0.26, 0.04), C_OLIVE, BORE_Y - 0.45, BORE_Y - 0.07),
    paint(box(0.12, 0.10, 0.20).translate(-0.24, BORE_Y - 0.02, 0.02), C_DARK, BORE_Y - 0.07, BORE_Y + 0.03),
    ...beltParts,
    // Spade grips.
    paint(box(0.46, 0.05, 0.05).translate(0, BORE_Y - 0.02, 0.46), C_STEEL, BORE_Y - 0.05, BORE_Y + 0.01),
    paint(box(0.06, 0.18, 0.06).translate(0.20, BORE_Y - 0.11, 0.47), C_RUBBER, BORE_Y - 0.2, BORE_Y - 0.02),
    paint(box(0.06, 0.18, 0.06).translate(-0.20, BORE_Y - 0.11, 0.47), C_RUBBER, BORE_Y - 0.2, BORE_Y - 0.02),
    // Perforated shroud around the rear of the barrels.
    paint(tube(0.155, 0.62, 10, 0, BORE_Y, -0.92), C_DARK, BORE_Y - 0.16, BORE_Y + 0.16),
  ], false)
  const body = new Mesh(bodyGeo, lit)
  recoil.add(body)

  // ---- barrel cluster: spins about the bore ----------------------------------
  const spinner = new Group()
  spinner.position.set(0, BORE_Y, 0)
  recoil.add(spinner)
  const barrelParts = []
  const R = 0.085
  const bLen = 1.30
  const bCentre = -(L - bLen * 0.5)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU
    const hex = i % 2 ? C_GUNMETAL : C_STEEL
    barrelParts.push(paint(tube(0.032, bLen, 6, Math.cos(a) * R, Math.sin(a) * R, bCentre), hex, -R, R))
  }
  // Front and mid clamp rings: without them six rods read as six rods.
  barrelParts.push(paint(tube(0.13, 0.06, 10, 0, 0, -(L - 0.10)), C_DARK, -0.13, 0.13))
  barrelParts.push(paint(tube(0.135, 0.06, 10, 0, 0, -(L - 0.72)), C_DARK, -0.13, 0.13))
  const barrels = new Mesh(mergeGeometries(barrelParts, false), lit)
  spinner.add(barrels)

  scene.add(root)

  // ---- laser sight ------------------------------------------------------------
  const streakGeo = buildStreak()
  const coreMat = additive(C_LASER)
  const glowMat = additive(C_LASER)
  const beamCore = new Mesh(streakGeo, coreMat)
  const beamGlow = new Mesh(streakGeo, glowMat)
  beamCore.renderOrder = 11
  beamGlow.renderOrder = 10
  beamCore.frustumCulled = false
  beamGlow.frustumCulled = false
  beamCore.visible = false
  beamGlow.visible = false
  scene.add(beamGlow, beamCore)

  const retGeo = new TorusGeometry(RETICLE_R, 0.05, 6, 28).rotateX(-Math.PI / 2)
  const retMat = additive(C_LASER)
  const reticle = new Mesh(retGeo, retMat)
  reticle.renderOrder = 9
  reticle.visible = false
  scene.add(reticle)

  // ---- view-owned state -------------------------------------------------------
  let yawR = 0
  let truckX = 0
  let recoilX = 0
  let recoilV = 0
  let heat = 0
  let spin = 0
  let clock = 0

  function sync(w, dt) {
    const on = w.mode === MODE_TURRET
    root.visible = on
    if (!on) {
      beamCore.visible = beamGlow.visible = reticle.visible = false
      return
    }
    const step = dt > MAX_SPRING_STEP ? MAX_SPRING_STEP : dt
    clock += dt

    // Pose. Sign flipped: sim yaw is positive toward +x, three's rotateY is
    // right-handed about +Y so a positive angle swings -Z toward -x.
    const kp = 1 - Math.exp(-dt / YAW_TAU)
    yawR += (w.turretYaw - yawR) * kp
    truckX += (w.turretX - truckX) * kp
    yaw.rotation.y = -yawR
    root.position.x = truckX

    // Recoil: semi-implicit Euler on a clamped step, sets the receiver BACK
    // along +z (its own axis, so the setback follows the yaw).
    const k = RECOIL_OMEGA * RECOIL_OMEGA
    const c = 2 * RECOIL_ZETA * RECOIL_OMEGA
    recoilV += (-k * recoilX - c * recoilV) * step
    recoilX += recoilV * step
    recoil.position.z = clamp(recoilX, -0.3, 1.5) * RECOIL_GAIN
    // A hair of pitch under recoil: the muzzle climbs, the grips dip.
    recoil.rotation.x = clamp(recoilX, 0, 1.5) * 0.012

    heat = damp(heat, 0, Math.exp(-1 / HEAT_FALL), dt)
    spin += SPIN_RATE * heat * dt
    if (spin > TAU) spin -= TAU * Math.floor(spin / TAU)
    spinner.rotation.z = spin

    // Beam: muzzle -> last hit. Muzzle from the DRAWN yaw so the beam leaves
    // the barrels the eye sees, never a frame ahead of them.
    const t = CFG.turret
    const mx = truckX + Math.sin(yawR) * L
    const mz = t.z - Math.cos(yawR) * L
    _a.set(mx, BORE_Y, mz)
    const far = -CFG.world.spawnHorizon
    const hitZ = w.turretHitZ
    const landed = hitZ > far + 0.5
    // No blocker: the beam runs out into the fog, dropping to knee height so it
    // reads as lying on the road rather than floating.
    _b.set(w.turretHitX, landed ? HIT_Y : 0.45, landed ? hitZ : far)
    const len = _a.distanceTo(_b)
    const pulse = 0.82 + 0.18 * Math.sin(clock * 21)

    beamCore.position.lerpVectors(_a, _b, 0.5)
    beamCore.lookAt(_b)
    beamCore.scale.set(BEAM_CORE_W, BEAM_CORE_W, len)
    beamGlow.position.copy(beamCore.position)
    beamGlow.quaternion.copy(beamCore.quaternion)
    beamGlow.scale.set(BEAM_GLOW_W, BEAM_GLOW_W, len)
    coreMat.opacity = 0.85 * pulse
    glowMat.opacity = 0.16 * pulse
    beamCore.visible = beamGlow.visible = len > 0.2

    reticle.visible = landed
    if (landed) {
      reticle.position.set(w.turretHitX, 0.06, hitZ)
      const s = 1 + 0.10 * Math.sin(clock * 9)
      reticle.scale.set(s, 1, s)
      retMat.opacity = 0.75
    }
  }

  /** One round left the gun: kick the spring, heat the cluster. */
  function kick() {
    recoilV += RECOIL_KICK
    heat = Math.min(1, heat + (1 - heat) * (1 - Math.exp(-1 / (HEAT_RISE * 12))))
  }

  function reset() {
    yawR = 0
    truckX = 0
    recoilX = 0
    recoilV = 0
    heat = 0
    spin = 0
    clock = 0
    yaw.rotation.y = 0
    root.position.x = 0
    recoil.position.z = 0
    recoil.rotation.x = 0
    spinner.rotation.z = 0
    root.visible = false
    beamCore.visible = beamGlow.visible = reticle.visible = false
  }

  function dispose() {
    scene.remove(root, beamCore, beamGlow, reticle)
    baseGeo.dispose()
    cradleGeo.dispose()
    bodyGeo.dispose()
    barrels.geometry.dispose()
    streakGeo.dispose()
    retGeo.dispose()
    lit.dispose()
    coreMat.dispose()
    glowMat.dispose()
    retMat.dispose()
  }

  return { sync, kick, reset, dispose }
}
