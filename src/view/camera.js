/**
 * The whole camera rig in ONE file, because every line below is a write to the
 * same transform. Split across modules they fight, and the winner is whichever
 * one happened to run last.
 *
 * THE number here is followFactor 0.50. Lateral follow is PARTIAL and lagged
 * 0.20s on purpose: at 1:1 the squad is pinned to screen centre, so dragging
 * produces no on-screen motion of the thing you control and the input reads as
 * DEAD even at zero latency. Everything else in this file is garnish on that.
 *
 * SPLIT TIME BASE -- getting it backwards is the most common way a hitstop
 * feels like a dropped frame instead of a hit:
 *   RENDER dt -> follow spring, growth dolly, look target. They must not
 *                substep-jitter, and must stay smooth on a 144Hz panel.
 *   SCALED dt -> trauma decay, shake clock, FOV punch. A 70ms hitstop then
 *                FREEZES the shake mid-swing, which is what reads as force.
 *
 * Ordering: this runs BEFORE every other view module. Glyph quads and muzzle
 * billboards orient to camera.quaternion, so using last frame's camera is a
 * one-frame billboard lag, plainly visible on barrel numbers during a roll.
 */
import { Euler, Quaternion } from 'three'
import { CFG } from '../config.js'
import { approach, clamp, damp, lerp, remap } from '../util/math.js'

// Mirrors STATE.BOSS in sim/world.js. Copied rather than imported: the view
// layer reads sim DATA passed in as `w` and never imports from sim/.
const STATE_BOSS = 2

const ROLL_CLAMP = 0.05          // rad; roll saturates fast and is meant to
const VEL_TAU = 0.05             // s; see the smoothing note in sync()
const FOV_PUNCH_SMOOTHING = Math.exp(-1 / 0.11)   // fraction left after 1s
const FOV_PUNCH_MAX = 10         // degrees; two overlapping punches must not fisheye

// Boss handoff. BOSS_PUNCH_Z is the knob for how hard the finale crops.
const BOSS_LOOK_Y = 2.6
const BOSS_PUNCH_Z = 1.6
const BOSS_BLEND_TAU = 0.9       // ~ the boss entry decel, so the two move together

// Incommensurate by golden ratio: 1, phi, phi^2. Three sines at these ratios have
// no perceptible period over the ~0.3s a shake lasts.
const NF1 = 68.7, NF2 = 111.2, NF3 = 179.9

// Scratch, module scope. Nothing in sync() may allocate.
const _euler = new Euler(0, 0, 0, 'YXZ')
const _quat = new Quaternion()

/**
 * Deterministic value noise in ~[-1, 1], seeded per axis so no two axes correlate.
 *
 * NEVER per-frame Math.random(): uncorrelated white noise reads as a RENDERING
 * GLITCH, not as force. The eye only attributes shake to the world when the
 * motion is continuous, and it also has to be reproducible frame to frame or a
 * hitstop freeze would resume on a different curve.
 */
function shakeNoise(t, seed) {
  return 0.53 * Math.sin(t * NF1 + seed * 1.7)
    + 0.31 * Math.sin(t * NF2 + seed * 4.9)
    + 0.16 * Math.sin(t * NF3 + seed * 9.3)
}

/** Fraction of the gap left after one second, for a time constant in seconds. */
function smoothingFor(tau) {
  return Math.exp(-1 / Math.max(1e-4, tau))
}

export function createCameraRig(camera) {
  let camX = 0
  let dollyZ = 0
  let velSmooth = 0
  let bossBlend = 0
  let trauma = 0
  let shakeT = 0
  let fovPunch = 0

  const rig = {
    /**
     * @param {object} w         sim world, READ ONLY
     * @param {number} rawDt     real frame seconds
     * @param {number} scaledDt  frame seconds after the hitstop timescale
     * @param {number} alpha     substep remainder. Deliberately unused: the
     *   follow spring already runs at render dt and IS the interpolator, so
     *   interpolating the anchor as well makes the two beat against each other.
     */
    sync(w, rawDt, scaledDt, alpha) {
      const c = CFG.camera

      // ---- RENDER dt: pose --------------------------------------------------

      // anchorVelX is integrator state now, not a finite difference, so it no
      // longer arrives as a 60Hz staircase -- but it still steps once per
      // substep, and the roll is sensitive enough that the smoothing stays.
      velSmooth = damp(velSmooth, w.anchorVelX, smoothingFor(VEL_TAU), rawDt)

      camX = damp(camX, w.anchorX * c.followFactor, smoothingFor(c.followTau), rawDt)

      bossBlend = damp(bossBlend, w.state === STATE_BOSS ? 1 : 0, smoothingFor(BOSS_BLEND_TAU), rawDt)

      // Growth dolly: pull back so 40 soldiers stay framed. The cap matters more
      // than the gain -- uncapped, a big squad earns a wide establishing shot of
      // the boss, and the finale's entire read is that it is too big for the frame.
      // During the boss the dolly is OVERRIDDEN inward for the same reason.
      const grown = c.basePos[2] + c.dollyGain * Math.log2(Math.max(1, w.count) / CFG.squad.startCount)
      const dollyTarget = lerp(
        clamp(grown, c.basePos[2], c.dollyMaxZ),
        c.basePos[2] - BOSS_PUNCH_Z,
        bossBlend,
      )
      dollyZ = damp(dollyZ, dollyTarget, Math.exp(-c.dollyOmega), rawDt)

      // Rise along the line through the look point, so pulling back changes the
      // framing WIDTH and never the pitch. Recomputed from CFG so retuning the
      // base pose cannot silently tilt the whole dolly range.
      const pitchSlope = (c.basePos[1] - c.lookY) / (c.basePos[2] - c.lookZ)
      const camY = c.lookY + pitchSlope * (dollyZ - c.lookZ)

      // The look target does NOT lag; only the position does. That difference is
      // what lets the squad slide off centre under a fast drag and settle back.
      const lookX = w.anchorX * c.lookXFactor + velSmooth * c.lookVelFactor
      const lookY = lerp(c.lookY, BOSS_LOOK_Y, bossBlend)

      // ---- SCALED dt: impact ------------------------------------------------
      trauma = approach(trauma, 0, c.traumaDecay * scaledDt)
      shakeT += scaledDt
      fovPunch = damp(fovPunch, 0, FOV_PUNCH_SMOOTHING, scaledDt)

      // ---- one composed write ----------------------------------------------
      camera.position.set(camX, camY, dollyZ)
      camera.lookAt(lookX, lookY, c.lookZ)

      // Counter-roll on lateral velocity. One clamped float, and it is most of
      // why the drag reads as a physical body being thrown around a corner.
      let roll = clamp(-velSmooth * c.rollGain, -ROLL_CLAMP, ROLL_CLAMP)
      let yaw = 0
      let pitch = 0

      if (trauma > 0) {
        // Amplitude is trauma SQUARED: a 0.10 bubble tap is nearly invisible and
        // a 1.0 boss death is violent, from one additive 0..1 scale.
        const s = trauma * trauma
        yaw = c.shakeYaw * s * shakeNoise(shakeT, 0)
        pitch = c.shakePitch * s * shakeNoise(shakeT, 1)
        roll += c.shakeRoll * s * shakeNoise(shakeT, 2)
        // Applied AFTER lookAt: offset the position first and the re-aim cancels
        // most of the translation back out.
        camera.position.x += c.shakePos * s * shakeNoise(shakeT, 3)
        camera.position.y += c.shakePos * s * shakeNoise(shakeT, 4)
      }

      // Post-multiply: the offsets are in CAMERA space, so yaw/pitch/roll stay
      // yaw/pitch/roll no matter where the rig is looking.
      _euler.set(pitch, yaw, roll, 'YXZ')
      _quat.setFromEuler(_euler)
      camera.quaternion.multiply(_quat)

      const fov = c.fov
        + remap(w.scroll, CFG.world.scrollStart, CFG.world.scrollEnd, 0, c.fovSpeedKick)
        + fovPunch
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }

      // The renderer updates the camera matrix, but only at the END of the frame.
      // Billboards run between here and there and read matrixWorld.
      camera.updateMatrixWorld()
    },

    /** Additive 0..1 kick. Amplitudes live in CFG.camera.trauma. */
    addTrauma(amount) {
      // CFG.camera.trauma.kill ships at 0.0, so a zero amount is the hot path.
      if (!(amount > 0)) return
      trauma = clamp(trauma + amount, 0, 1)
    },

    /** Transient FOV kick in degrees; eases back on scaled dt. */
    punchFov(degrees) {
      if (!Number.isFinite(degrees)) return
      fovPunch = clamp(fovPunch + degrees, -FOV_PUNCH_MAX, FOV_PUNCH_MAX)
    },

    /**
     * Instant restart. Allocation-free, and it snaps the pose rather than damping
     * to it -- a spring left holding its old value whip-pans across the corridor
     * on the first frame of the new run.
     */
    reset() {
      const c = CFG.camera
      camX = 0
      dollyZ = c.basePos[2]
      velSmooth = 0
      bossBlend = 0
      trauma = 0
      shakeT = 0
      fovPunch = 0

      camera.up.set(0, 1, 0)
      camera.fov = c.fov
      camera.near = c.near
      camera.far = c.far
      camera.updateProjectionMatrix()
      camera.position.set(c.basePos[0], c.basePos[1], c.basePos[2])
      camera.lookAt(0, c.lookY, c.lookZ)
      camera.updateMatrixWorld()
    },

    /** Owns no GPU resources; present so the rig matches the view module shape. */
    dispose() {},
  }

  rig.reset()
  return rig
}
