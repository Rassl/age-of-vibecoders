/**
 * The DOM HUD. Five things and nothing else: squad count, the one bar, the weapon
 * that just changed, the damage vignette, and the boss rage ring.
 *
 * DOM rather than in-world text because text in the corridor competes with the
 * thing it is describing, and because a DOM HUD costs ZERO draw calls against a
 * 40-call budget.
 *
 * EVERY frame path here writes TRANSFORM AND OPACITY ONLY, through a cached
 * last-value per element, and never reads offsetWidth / getBoundingClientRect.
 * A single layout-triggering read inside sync() forces a synchronous reflow in
 * the middle of the frame -- which shows up as sporadic 8ms spikes that look
 * exactly like a GPU problem and are debugged as one for a day.
 *
 * There is ONE bar. A separate boss bar would be a second element competing for
 * the same glance at the exact moment the player has no attention to spare, so
 * the run-progress bar becomes the boss HP bar in place.
 */
import { CFG } from '../config.js'
import { WEAPONS } from '../data/weapons.js'
import { clamp, damp, lerp, smoothstep } from '../util/math.js'

// Mirrored from sim/world.js STATE. The view never imports from sim/, and these
// two numbers are the only sim constants the HUD needs.
const ST_RUNNING = 1
const ST_BOSS = 2

const PUNCH_DUR = 0.22
const PUNCH_ATTACK = 0.28   // fraction of the punch spent rising
const PUNCH_AMP = 0.35
const WEP_HOLD = 1.5
const WEP_FADE = 0.4
const VIG_SMOOTH = 0.004    // fraction of the flash left after one second
const CHIP_HOLD = 0.35
const CHIP_DRAIN = 1.5      // bar-fractions per second
const RAGE_R = 13
const RAGE_C = 2 * Math.PI * RAGE_R

// Colour ramps are BAKED at boot. The count tint changes every frame during a
// punch, so building `rgb(...)` strings live would allocate ~13 strings per
// punch in the one path that must not allocate at all.
const TINT_N = 9
const TINT_GAIN = buildRamp(244, 241, 234, 124, 224, 138)
const TINT_LOSS = buildRamp(244, 241, 234, 255, 90, 74)

function buildRamp(r0, g0, b0, r1, g1, b1) {
  const out = new Array(TINT_N)
  for (let i = 0; i < TINT_N; i++) {
    const t = i / (TINT_N - 1)
    out[i] = `rgb(${Math.round(lerp(r0, r1, t))},${Math.round(lerp(g0, g1, t))},${Math.round(lerp(b0, b1, t))})`
  }
  return out
}

const STYLE_ID = 'aov-hud-style'
const CSS = `
.aov-hud{position:absolute;inset:0;pointer-events:none;opacity:0;
  transition:opacity 200ms ease;color:#F4F1EA;contain:layout style;}
.aov-vig{position:absolute;inset:-3%;opacity:0;will-change:opacity;
  background:radial-gradient(ellipse at 50% 60%,rgba(229,72,77,0) 28%,
    rgba(196,44,40,.40) 66%,rgba(118,14,12,.92) 100%);}
.aov-bar{position:absolute;left:14px;right:14px;height:4px;overflow:hidden;
  top:calc(env(safe-area-inset-top,0px) + 12px);
  background:rgba(244,241,234,.14);box-shadow:0 1px 3px rgba(0,0,0,.5);}
.aov-chip,.aov-fill{position:absolute;inset:0;transform:scaleX(0);
  transform-origin:0 50%;will-change:transform;}
.aov-chip{background:#FFE9B0;opacity:0;will-change:opacity,transform;}
.aov-fill{background:#D8CBA6;}
.aov-dist{position:absolute;left:0;right:0;top:26px;text-align:center;
  font:800 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.10em;
  color:#EFE3C4;text-shadow:0 1px 2px rgba(0,0,0,.55);pointer-events:none;}
.aov-bar.boss{background:rgba(107,74,99,.55);}
.aov-bar.boss .aov-fill{background:#E5484D;}
.aov-wep{position:absolute;left:0;right:0;text-align:center;font-size:11px;
  top:calc(env(safe-area-inset-top,0px) + 26px);
  letter-spacing:.34em;text-indent:.34em;color:#E0C9A0;opacity:0;
  will-change:opacity;text-shadow:0 1px 3px rgba(0,0,0,.8);}
.aov-wings{position:absolute;left:0;right:0;text-align:center;font-size:11px;
  top:calc(env(safe-area-inset-top,0px) + 44px);
  letter-spacing:.30em;text-indent:.30em;color:#8FEFFF;opacity:0;
  will-change:opacity;text-shadow:0 1px 3px rgba(0,0,0,.8);}
.aov-rage{position:absolute;right:10px;width:32px;height:32px;opacity:0;
  top:calc(env(safe-area-inset-top,0px) + 24px);
  transition:opacity 220ms ease;will-change:opacity;}
.aov-snd,.aov-pause{position:absolute;right:10px;width:34px;height:34px;
  top:calc(env(safe-area-inset-top,0px) + 66px);
  pointer-events:auto;cursor:pointer;border:0;border-radius:50%;
  background:rgba(11,13,16,.45);color:#EFE3C4;font-size:16px;line-height:34px;
  padding:0;text-align:center;-webkit-tap-highlight-color:transparent;}
.aov-snd.off{opacity:.55;}
.aov-pause{top:calc(env(safe-area-inset-top,0px) + 108px);font-size:14px;}
.aov-rage .t{fill:none;stroke:rgba(11,13,16,.55);stroke-width:3;}
.aov-rage .a{fill:none;stroke:#E0C9A0;stroke-width:3;}
.aov-rage.raging .a{stroke:#E5484D;animation:aov-blink .48s steps(2,end) infinite;}
@keyframes aov-blink{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}
/* The squad count now lives IN THE WORLD, over the formation (view/labels.js),
   the way the reference runners print it on the crowd. The DOM count stays
   wired -- the punch and tint ramps are still driven -- but is not shown, so
   the bottom 28% of the screen is entirely the squad's band and the thumb's. */
.aov-count{position:absolute;left:0;right:0;text-align:center;display:none;
  bottom:calc(9% + env(safe-area-inset-bottom,0px));}
.aov-count-n{display:inline-block;font-size:clamp(42px,13vw,76px);line-height:.9;
  font-weight:700;letter-spacing:-.02em;transform-origin:50% 60%;
  will-change:transform;transform:scale(1);color:#F4F1EA;
  text-shadow:0 2px 0 rgba(0,0,0,.45),0 0 24px rgba(0,0,0,.6);}
.aov-count-cap{margin-top:3px;font-size:9px;letter-spacing:.42em;
  text-indent:.42em;color:rgba(224,201,160,.5);}
/* TURRET mode: the gun owns the bottom of the frame, so the count moves to
   the top-left corner, smaller. The thumb's band is the whole screen there. */
.aov-hud.turret .aov-count{bottom:auto;right:auto;left:14px;text-align:left;
  top:calc(env(safe-area-inset-top,0px) + 44px);}
.aov-hud.turret .aov-count-n{font-size:clamp(30px,8vw,44px);transform-origin:0 60%;}
`

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

function div(cls, parent) {
  const el = document.createElement('div')
  el.className = cls
  if (parent) parent.appendChild(el)
  return el
}

/** Per-element cache of every property we write. Fixed monomorphic shape. */
function track(el) {
  return { el, s: NaN, x: NaN, o: NaN, d: NaN, c: '', t: '', n: NaN, f: -1 }
}

function writeScale(r, s) {
  if (r.s === s) return
  r.s = s
  r.el.style.transform = `scale(${s})`
}

function writeScaleX(r, x) {
  if (r.x === x) return
  r.x = x
  r.el.style.transform = `scaleX(${x})`
}

function writeOpacity(r, o) {
  if (r.o === o) return
  r.o = o
  r.el.style.opacity = o
}

function writeColor(r, c) {
  if (r.c === c) return
  r.c = c
  r.el.style.color = c
}

function writeText(r, t) {
  if (r.t === t) return
  r.t = t
  r.el.textContent = t
}

function writeNum(r, n) {
  if (r.n === n) return
  r.n = n
  r.el.textContent = n
}

/**
 * The SVG presentation attribute, not the CSS property: unitless lengths are
 * unambiguously legal there, and nothing in the stylesheet can outrank it.
 */
function writeDash(r, d) {
  if (r.d === d) return
  r.d = d
  r.el.setAttribute('stroke-dashoffset', d)
}

function writeFlag(r, f, cls) {
  if (r.f === f) return
  r.f = f
  if (f) r.el.classList.add(cls)
  else r.el.classList.remove(cls)
}

const q100 = (v) => Math.round(v * 100) / 100
const q1000 = (v) => Math.round(v * 1000) / 1000

/**
 * @param {HTMLElement} root the #hud div
 */
export function createHud(root) {
  injectStyle()

  const gate = div('aov-hud', root)
  const vig = div('aov-vig', gate)
  const bar = div('aov-bar', gate)
  const chip = div('aov-chip', bar)
  const fill = div('aov-fill', bar)
  const dist = div('aov-dist', gate)
  const wep = div('aov-wep', gate)
  const wingsEl = div('aov-wings', gate)
  const countBox = div('aov-count', gate)
  const countN = div('aov-count-n', countBox)
  div('aov-count-cap', countBox).textContent = 'SQUAD'

  const svgNS = 'http://www.w3.org/2000/svg'
  const rageSvg = document.createElementNS(svgNS, 'svg')
  rageSvg.setAttribute('class', 'aov-rage')
  rageSvg.setAttribute('viewBox', '0 0 32 32')
  const rageTrack = document.createElementNS(svgNS, 'circle')
  const rageArc = document.createElementNS(svgNS, 'circle')
  for (const c of [rageTrack, rageArc]) {
    c.setAttribute('cx', '16'); c.setAttribute('cy', '16'); c.setAttribute('r', String(RAGE_R))
  }
  rageTrack.setAttribute('class', 't')
  rageArc.setAttribute('class', 'a')
  rageArc.setAttribute('stroke-dasharray', String(RAGE_C))
  // Attribute rather than a CSS transform: transform-origin on SVG children is
  // the one place browsers still disagree, and this ring must start at 12 o'clock.
  rageArc.setAttribute('transform', 'rotate(-90 16 16)')
  rageSvg.appendChild(rageTrack)
  rageSvg.appendChild(rageArc)
  gate.appendChild(rageSvg)

  const rGate = track(gate)
  // A second tracker on the same element: `track` caches one flag per record,
  // and the gate already spends its on nothing, but keeping the mode class on
  // its own record means a future flag on the gate cannot fight it.
  const rGateMode = track(gate)
  const rVig = track(vig)
  const rBar = track(bar)
  const rFill = track(fill)
  const rChip = track(chip)
  const rDist = track(dist)
  const rWep = track(wep)
  const rWings = track(wingsEl)
  const rCount = track(countN)
  const rRage = track(rageSvg)
  const rArc = track(rageArc)

  let punchT = 99, punchDir = 1
  let vigA = 0
  let wepT = 0, lastTier = -1
  let chipF = 1, chipHold = 0, lastHpF = 1
  let prevNow = 0

  /**
   * @param {object} w world, read-only
   * @param {number} [dt] seconds; derived from the wall clock if the caller does
   *   not thread it through, so the HUD animates under any host loop.
   */
  function sync(w, dt) {
    const now = performance.now() * 0.001
    if (dt === undefined) dt = prevNow === 0 ? 1 / 60 : now - prevNow
    prevNow = now
    if (!(dt > 0)) dt = 0
    else if (dt > CFG.sim.dtClamp) dt = CFG.sim.dtClamp

    // ---- READS AND MATH ONLY ----------------------------------------------
    const st = w.state
    const live = st === ST_RUNNING || st === ST_BOSS
    const b = w.boss
    const bossOn = st === ST_BOSS && b.active && !b.dead && b.maxHp > 0

    if (punchT < 10) punchT += dt
    let punch = 0
    if (punchT < PUNCH_DUR) {
      const t = punchT / PUNCH_DUR
      punch = t < PUNCH_ATTACK
        ? smoothstep(t / PUNCH_ATTACK)
        : 1 - smoothstep((t - PUNCH_ATTACK) / (1 - PUNCH_ATTACK))
    }

    vigA = damp(vigA, 0, VIG_SMOOTH, dt)
    if (vigA < 0.004) vigA = 0

    if (lastTier !== w.tier) {
      // The first tier seen is the run's starting weapon, not a pickup: showing
      // it would train the player to ignore the one label that means "you got
      // stronger".
      if (lastTier >= 0) wepT = WEP_HOLD
      lastTier = w.tier
    } else if (wepT > 0) {
      wepT -= dt
      if (wepT < 0) wepT = 0
    }
    const wepName = WEAPONS[clamp(w.tier, 0, WEAPONS.length - 1)].name
    const wepOp = wepT >= WEP_FADE ? 1 : wepT / WEP_FADE

    let fillF
    if (bossOn) {
      const hpF = clamp(b.hp / b.maxHp, 0, 1)
      // Chip damage: the fill snaps, the pale ghost behind it holds 350ms then
      // drains. Without the lag a 900-damage burst on a 14k boss is a 6% nudge
      // the player never sees, and the fight reads as unresponsive.
      if (hpF < lastHpF) chipHold = CHIP_HOLD
      lastHpF = hpF
      if (hpF >= chipF) chipF = hpF
      else if (chipHold > 0) chipHold -= dt
      else chipF = Math.max(hpF, chipF - CHIP_DRAIN * dt)
      fillF = hpF
    } else {
      fillF = clamp(w.runTime / CFG.world.runSeconds, 0, 1)
      chipF = 1; chipHold = 0; lastHpF = 1
    }
    const chipOp = bossOn && chipF > fillF + 0.002 ? 0.55 : 0

    const rageF = bossOn ? clamp(b.rage / CFG.boss.rageTimer, 0, 1) : 0
    const ramp = punchDir < 0 ? TINT_LOSS : TINT_GAIN

    // ---- WRITES ONLY BELOW. Nothing here reads back from the DOM. ----------
    writeOpacity(rGate, live ? 1 : 0)
    writeFlag(rGateMode, w.mode === 2 ? 1 : 0, 'turret')
    writeOpacity(rVig, q100(vigA))

    writeFlag(rBar, bossOn ? 1 : 0, 'boss')
    writeScaleX(rFill, q1000(fillF))
    writeScaleX(rChip, q1000(chipF))
    writeOpacity(rChip, chipOp)

    // Metres travelled, as in the reference. Quantised to 1m so the readout is a
    // steady tick rather than a blur -- at ~16u/s an unquantised value repaints
    // every frame and is unreadable. HOLDOUT (mode 1) has no distance -- the
    // squad is planted -- so the same slot counts down the time left to hold.
    if (w.mode === 1) {
      const left = Math.max(0, Math.ceil(CFG.world.runSeconds - w.runTime))
      writeNum(rDist, w.state >= 2
        ? 'HOLD'
        : 'HOLD ' + ((left / 60) | 0) + ':' + String(left % 60).padStart(2, '0'))
    } else {
      writeNum(rDist, Math.round(w.distance) + ' m')
    }

    writeText(rWep, wepName)
    writeOpacity(rWep, q100(wepOp))

    // Wings countdown. Whole seconds: a tenths readout repaints every frame.
    const flying = w.wings > 0
    if (flying) writeText(rWings, 'WINGS ' + Math.ceil(w.wings) + 'S')
    writeOpacity(rWings, flying ? 1 : 0)

    writeNum(rCount, w.count)
    writeScale(rCount, q100(1 + PUNCH_AMP * punch))
    writeColor(rCount, ramp[Math.round(punch * (TINT_N - 1))])

    writeOpacity(rRage, bossOn ? 1 : 0)
    writeFlag(rArc, bossOn && b.raging ? 1 : 0, 'raging')
    writeDash(rArc, q100(RAGE_C * (1 - rageF)))
  }

  /** @param {number} delta signed change in soldier count. */
  function pulseCount(delta) {
    if (delta === 0) return
    // A loss retriggers over an in-flight gain, never the reverse: a bubble
    // landing in the same 180ms aggregation window must not eat the red pop.
    if (delta > 0 && punchDir < 0 && punchT < PUNCH_DUR) return
    punchT = 0
    punchDir = delta > 0 ? 1 : -1
  }

  /** @param {number} fraction share of the squad just lost, 0..1. */
  function flashDamage(fraction) {
    const a = 0.22 + 0.78 * clamp(fraction, 0, 1)
    if (a > vigA) vigA = a
  }

  /** Allocation-free, and never touches the DOM structure. */
  function reset() {
    punchT = 99; punchDir = 1
    vigA = 0
    wepT = 0; lastTier = -1
    chipF = 1; chipHold = 0; lastHpF = 1
    prevNow = 0
  }

  function dispose() {
    if (gate.parentNode) gate.parentNode.removeChild(gate)
  }

  /**
   * Speaker toggle, below the rage ring, alive across every game state (it
   * hangs off `root`, not the run-scoped gate). `onToggle` returns the new
   * muted state; pointer events are stopped so a tap can never leak into the
   * steering drag or the tap-to-start scrim.
   */
  function soundButton(initialMuted, onToggle) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'aov-snd' + (initialMuted ? ' off' : '')
    b.textContent = initialMuted ? '\u{1F507}' : '\u{1F50A}'
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'mousedown']) {
      b.addEventListener(ev, (e) => e.stopPropagation())
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const m = onToggle()
      b.textContent = m ? '\u{1F507}' : '\u{1F50A}'
      b.classList.toggle('off', m)
      b.blur()
    })
    root.appendChild(b)
    return b
  }

  /**
   * Pause toggle, below the sound button. `onToggle` returns the new paused
   * state; `set` lets the restart path force the icon back to running, so a
   * retry from a paused end screen cannot leave a stale play glyph.
   */
  function pauseButton(onToggle) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'aov-pause'
    const set = (paused) => { b.textContent = paused ? '▶' : '⏸' }
    set(false)
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'mousedown']) {
      b.addEventListener(ev, (e) => e.stopPropagation())
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      set(onToggle())
      b.blur()
    })
    root.appendChild(b)
    return { el: b, set }
  }

  return { sync, pulseCount, flashDamage, soundButton, pauseButton, reset, dispose }
}
