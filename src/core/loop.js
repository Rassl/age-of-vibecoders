/**
 * Fixed-timestep loop with a hitstop timescale stack.
 *
 * dt is clamped FIRST (a backgrounded tab returns a multi-second delta and every
 * entity would teleport through every collision test on the first frame back),
 * and scaled EXACTLY ONCE here -- hitstop must scale the simulation, or the
 * springs and the sim disagree about how long a second is.
 */
import { CFG, FIXED_DT } from '../config.js'

export class Loop {
  constructor(step, render, beforeStep) {
    this.step = step
    this.render = render
    // Called ONCE per frame before any substep -- this is where input is drained.
    this.beforeStep = beforeStep || null
    this.accumulator = 0
    this.last = 0
    this.running = false
    this.frameMs = 16.7
    // hitstop: [timescale, secondsRemaining, rampSeconds]
    this.hitstop = 0
    this.hitstopTotal = 0
    this.hitstopScale = 1
    this.hitstopRamp = 0
    this.timescale = 1
    this.rafId = 0
    this._tick = this._tick.bind(this)
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.rafId = requestAnimationFrame(this._tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  /** Freeze time briefly for impact. Strongest wins; never stacks additively. */
  punch(scale, hold, ramp) {
    if (this.hitstop > 0 && scale > this.hitstopScale) return
    this.hitstopScale = scale
    this.hitstop = hold + ramp
    this.hitstopTotal = hold + ramp
    this.hitstopRamp = ramp
  }

  clearHitstop() {
    this.hitstop = 0
    this.timescale = 1
  }

  /**
   * Re-anchor the clock. The restart path does enough synchronous work to be a
   * frame boundary in its own right, and carrying the old accumulator across it
   * spends the first steps of the new run catching up on the old one's time.
   */
  resync() {
    this.accumulator = 0
    this.last = performance.now()
  }

  _tick(now) {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this._tick)

    // Clamp BOTH ends. The upper bound is the backgrounded-tab guard; the lower
    // bound matters just as much and was missing. `now` is a rAF timestamp and
    // `last` can have been stamped from performance.now() or from an earlier
    // frame, so after any long synchronous block -- shader prewarm, the restart
    // path, a GC pause -- rAF can hand back a timestamp EARLIER than `last`. A
    // negative dt goes straight into the accumulator, and because nothing ever
    // adds it back faster than real time, the simulation silently stops dead
    // until the accumulator climbs back to +FIXED_DT. Measured at -1.87s: the
    // squad ignored input for nearly two seconds after every start.
    const delta = now - this.last
    const rawDt = delta < 0 ? 0 : Math.min(delta / 1000, CFG.sim.dtClamp)
    this.frameMs = delta < 0 ? 0 : delta
    this.last = now

    // Resolve the hitstop timescale for this frame.
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - rawDt)
      const ramp = this.hitstopRamp
      // Hold at full freeze, then ease back to 1 over the ramp.
      this.timescale = this.hitstop > ramp
        ? this.hitstopScale
        : this.hitstopScale + (1 - this.hitstopScale) * (1 - this.hitstop / Math.max(1e-4, ramp))
    } else {
      this.timescale = 1
    }

    const scaledDt = rawDt * this.timescale
    this.accumulator += scaledDt

    if (this.beforeStep) this.beforeStep(rawDt)

    let steps = 0
    // Excess accumulator time is DROPPED, not simulated: a hitch must not cause
    // a death spiral.
    const n = Math.min(CFG.sim.maxSubsteps, Math.floor(this.accumulator / FIXED_DT)) || 0
    while (this.accumulator >= FIXED_DT && steps < CFG.sim.maxSubsteps) {
      this.step(FIXED_DT, n || 1)
      this.accumulator -= FIXED_DT
      steps++
    }
    if (steps === CFG.sim.maxSubsteps) this.accumulator = Math.min(this.accumulator, FIXED_DT)

    const alpha = this.accumulator / FIXED_DT
    this.render(rawDt, scaledDt, alpha, this.frameMs)
  }
}
