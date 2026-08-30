/**
 * Pointer + keyboard steering.
 *
 * RELATIVE (delta) drag, not absolute: an absolute mapping teleports the squad
 * to wherever the thumb lands, which is unplayable one-handed. Relative also
 * gives infinite travel through re-gripping, and on release the squad HOLDS
 * POSITION -- inertia drifts you off the barrel you just lined up, and
 * auto-centering punishes resting your thumb.
 *
 * Deltas accumulate in CSS pixels and are drained ONCE at the top of the frame.
 * Reading pointer state inside the render step instead costs a full frame of
 * invisible latency that no amount of spring tuning recovers.
 */
import { CFG } from '../config.js'

export class Input {
  constructor(canvas) {
    this.canvas = canvas
    this.dxPx = 0
    this.dragging = false
    this.pointerId = -1
    this.lastX = 0
    // Every pointer currently down, not just the one steering. Without this a
    // second finger cannot take over when the first lifts, and steering stays
    // dead until the player releases everything and re-presses.
    this.active = new Map()
    this.keyLeft = false
    this.keyRight = false
    this.onRestart = null
    this.enabled = true
    this._bind()
  }

  _bind() {
    const c = this.canvas
    const opts = { passive: false }

    c.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return
      e.preventDefault()
      this.active.set(e.pointerId, e.clientX)
      if (this.dragging) return
      this.dragging = true
      this.pointerId = e.pointerId
      this.lastX = e.clientX
      try { c.setPointerCapture(e.pointerId) } catch { /* capture is best-effort */ }
    }, opts)

    c.addEventListener('pointermove', (e) => {
      if (this.active.has(e.pointerId)) this.active.set(e.pointerId, e.clientX)
      if (!this.dragging || e.pointerId !== this.pointerId) return
      e.preventDefault()
      // Coalesced events recover sub-frame precision on high-rate digitizers:
      // without this a 240Hz pen or a 120Hz touch panel throws away 3 of 4 samples.
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
      if (events && events.length) {
        for (let i = 0; i < events.length; i++) {
          this.dxPx += events[i].clientX - this.lastX
          this.lastX = events[i].clientX
        }
      } else {
        this.dxPx += e.clientX - this.lastX
        this.lastX = e.clientX
      }
    }, opts)

    const end = (e) => {
      this.active.delete(e.pointerId)
      if (e.pointerId !== this.pointerId) return
      try { c.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      // Hand the drag to whichever finger is still down, seeding lastX from its
      // CURRENT position so the handover contributes no delta and the squad does
      // not jump to wherever that finger happened to be resting.
      const next = this.active.entries().next()
      if (!next.done) {
        this.pointerId = next.value[0]
        this.lastX = next.value[1]
        this.dragging = true
        try { c.setPointerCapture(this.pointerId) } catch { /* best-effort */ }
        return
      }
      this.dragging = false
      this.pointerId = -1
    }
    c.addEventListener('pointerup', end, opts)
    c.addEventListener('pointercancel', end, opts)

    // iOS steals the drag as a page scroll or pull-to-refresh without these,
    // which presents to the player as "the controls do not work".
    c.addEventListener('touchstart', (e) => e.preventDefault(), opts)
    c.addEventListener('touchmove', (e) => e.preventDefault(), opts)
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    c.addEventListener('gesturestart', (e) => e.preventDefault())

    window.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.keyLeft = true
      if (e.code === 'ArrowRight' || e.code === 'KeyD') this.keyRight = true
      if (e.code === 'KeyR' && this.onRestart) this.onRestart()
    })
    window.addEventListener('keyup', (e) => {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.keyLeft = false
      if (e.code === 'ArrowRight' || e.code === 'KeyD') this.keyRight = false
    })
    window.addEventListener('blur', () => {
      this.active.clear()
      this.dragging = false
      this.pointerId = -1
      this.keyLeft = this.keyRight = false
    })
  }

  /**
   * Read and ZERO the accumulated POINTER delta exactly once, at the top of the
   * frame. Returns world units.
   */
  drainDx() {
    const world = this.dxPx * CFG.derived.dragGain
    this.dxPx = 0
    return world
  }

  /**
   * Discrete steering direction, -1 | 0 | +1.
   *
   * Keys are a DIRECTION, not a displacement. Turning a held key into
   * `speed * dt` of drag made the anchor chase a runaway target position, which
   * is what produced the lurch-then-crawl; the sim now integrates a velocity
   * from this axis instead. Opposed keys cancel rather than latching to the one
   * pressed first.
   */
  axis() {
    return (this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0)
  }

  reset() {
    this.dxPx = 0
    this.dragging = false
    this.pointerId = -1
    this.active.clear()
  }
}
