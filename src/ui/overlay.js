/**
 * The two cards that bookend a run: the start prompt and the run-over panel.
 *
 * RESTART IS THE FEATURE. Tap or R goes straight back into a fresh run in one
 * frame: no reload, no teardown, no disposal, no confirm. Frictionless retry is
 * the retention mechanic of this genre, so this file must never own anything
 * that would need to be rebuilt -- both cards are built once at boot and only
 * their text nodes are rewritten.
 *
 * The end card tells the run's STORY (how big you got, what you let through,
 * what you were holding at the end) rather than a score. A score invites
 * optimisation of a number; a story invites another run.
 */
import { CFG } from '../config.js'
import { parSquad } from '../curves.js'
import { WEAPONS } from '../data/weapons.js'
import { clamp } from '../util/math.js'

const INSTRUCTION = 'DRAG TO MOVE — YOUR SQUAD FIRES ITSELF'
const ARM_MS = 380   // see armedAt

const GRADES = ['F', 'D', 'C', 'B', 'A', 'S']
const GRADE_MIN = [0, 0.34, 0.50, 0.66, 0.80, 0.92]
const ROWS = ['PEAK SQUAD', 'KILLS', 'BUBBLES TAKEN', 'BARRELS BREACHED', 'WEAPON']

const STYLE_ID = 'aov-overlay-style'
const CSS = `
.aov-scrim{position:absolute;inset:0;display:grid;place-items:center;
  pointer-events:auto;   /* the whole card IS the button; see hide() */
  padding:calc(env(safe-area-inset-top,0px) + 24px) calc(env(safe-area-inset-right,0px) + 20px)
          calc(env(safe-area-inset-bottom,0px) + 28px) calc(env(safe-area-inset-left,0px) + 20px);
  background:
    radial-gradient(120% 62% at 50% 86%,rgba(224,201,160,.22),rgba(224,201,160,0) 62%),
    linear-gradient(180deg,rgba(11,13,16,.94) 0%,rgba(30,23,18,.90) 54%,rgba(11,13,16,.96) 100%);}
.aov-card{width:min(92vw,430px);text-align:center;color:#F4F1EA;
  animation:aov-rise 260ms cubic-bezier(.16,.9,.3,1) both;}
@keyframes aov-rise{from{opacity:0;transform:translate3d(0,14px,0)}to{opacity:1;transform:none}}
.aov-eyebrow{font-size:11px;letter-spacing:.46em;text-indent:.46em;color:#C2A878;}
.aov-title{font-size:clamp(34px,11.5vw,58px);line-height:.94;font-weight:700;
  letter-spacing:.02em;margin:10px 0 0;text-shadow:0 3px 0 rgba(0,0,0,.5);}
.aov-title.fail{color:#E5484D;}
.aov-title.win{color:#E0C9A0;}
.aov-rule{height:2px;margin:16px 0;background:linear-gradient(90deg,
  rgba(224,201,160,0),#E0C9A0 18%,#E0C9A0 82%,rgba(224,201,160,0));}
.aov-line{font-size:12px;letter-spacing:.16em;color:#C2A878;line-height:1.7;}
.aov-grade{font-size:74px;line-height:1;font-weight:700;letter-spacing:.02em;
  color:#0B0D10;background:#E0C9A0;display:inline-block;padding:6px 22px 10px;
  margin:2px 0 4px;clip-path:polygon(0 0,100% 0,100% 76%,88% 100%,0 100%);}
.aov-rows{margin:14px 0 20px;text-align:left;}
.aov-row{display:flex;justify-content:space-between;align-items:baseline;
  padding:7px 2px;border-bottom:1px solid rgba(224,201,160,.18);}
.aov-k{font-size:11px;letter-spacing:.2em;color:rgba(224,201,160,.72);}
.aov-v{font-size:17px;font-weight:700;letter-spacing:.04em;color:#F4F1EA;}
.aov-btn{font-size:17px;font-weight:700;letter-spacing:.3em;text-indent:.3em;
  color:#0B0D10;background:#E0C9A0;padding:14px 0 15px;
  clip-path:polygon(0 0,100% 0,100% 100%,14px 100%,0 calc(100% - 14px));}
.aov-hint{margin-top:12px;font-size:10px;letter-spacing:.3em;text-indent:.3em;
  color:rgba(194,168,120,.62);}
.aov-tap{margin-top:26px;font-size:13px;font-weight:700;letter-spacing:.34em;
  text-indent:.34em;color:#E0C9A0;animation:aov-pulse 1.5s ease-in-out infinite;}
@keyframes aov-pulse{0%{opacity:.32}50%{opacity:1}100%{opacity:.32}}
`

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

function div(cls, parent, text) {
  const el = document.createElement('div')
  el.className = cls
  if (text !== undefined) el.textContent = text
  if (parent) parent.appendChild(el)
  return el
}

/**
 * Grade from the four things the player actually controls: how big the squad
 * got, whether bubbles were collected, whether barrels were killed rather than
 * walked into, and what weapon was reached. Peak squad is measured against the
 * par curve, not against maxCount, so the grade means the same thing after a
 * balance change.
 */
function gradeFor(w, won) {
  const s = w.stats
  const par = Math.max(1, parSquad(CFG.world.runSeconds))
  const squadF = clamp(s.peakCount / par, 0, 1.2) / 1.2
  const bubbles = s.bubblesTaken + s.bubblesMissed
  const bubbleF = bubbles > 0 ? s.bubblesTaken / bubbles : 1
  const barrels = s.barrelsKilled + s.barrelsBreached
  const breachF = barrels > 0 ? s.barrelsKilled / barrels : 1
  const wepF = clamp(w.tier / Math.max(1, WEAPONS.length - 1), 0, 1)
  const score = 0.34 * squadF + 0.26 * bubbleF + 0.22 * breachF + 0.18 * wepF

  let idx = 0
  for (let i = GRADES.length - 1; i > 0; i--) {
    if (score >= GRADE_MIN[i]) { idx = i; break }
  }
  // A run that ended in the corridor is never better than a C. A grade that
  // disagrees with the outcome reads as a consolation prize.
  if (!won && idx > 2) idx = 2
  return GRADES[idx]
}

/**
 * @param {HTMLElement} root the #overlay div
 * @param {Function} onStart
 * @param {Function} onRestart
 */
export function createOverlay(root, onStart, onRestart) {
  injectStyle()

  // Set on the element rather than in the stylesheet so the factory works with
  // any root: the scrim re-enables pointer-events for itself, and nothing else
  // in the overlay can ever swallow a drag meant for the canvas.
  root.style.pointerEvents = 'none'
  const scrim = div('aov-scrim', root)

  // --- start card
  const startCard = div('aov-card', scrim)
  div('aov-eyebrow', startCard, 'CORRIDOR ASSAULT')
  div('aov-title', startCard, 'AGE OF VIBECODERS')
  div('aov-rule', startCard)
  div('aov-line', startCard, INSTRUCTION)
  div('aov-tap', startCard, 'TAP TO DEPLOY')

  // --- end card, built once: showEnd() only rewrites text nodes, so a restart
  //     never constructs or discards a node.
  const endCard = div('aov-card', scrim)
  const endTitle = div('aov-title', endCard)
  const endGrade = div('aov-grade', endCard)
  const rowsBox = div('aov-rows', endCard)
  const vals = new Array(ROWS.length)
  for (let i = 0; i < ROWS.length; i++) {
    const row = div('aov-row', rowsBox)
    div('aov-k', row, ROWS[i])
    vals[i] = div('aov-v', row)
  }
  div('aov-btn', endCard, 'RETRY')
  div('aov-hint', endCard, 'TAP ANYWHERE OR PRESS R')

  let mode = 0            // 0 none, 1 start, 2 end
  let armedAt = 0

  function show(next) {
    mode = next
    // Cards toggle via display, which restarts their entry animation for free
    // and costs no forced reflow read.
    startCard.style.display = next === 1 ? 'block' : 'none'
    endCard.style.display = next === 2 ? 'block' : 'none'
    root.style.display = 'grid'
    // Deaths arrive mid-panic. Without a short arm delay the tap already in
    // flight when the squad hit zero eats the end card and the player never
    // learns why the run ended.
    armedAt = performance.now() + ARM_MS
  }

  function showStart() {
    show(1)
  }

  function showEnd(w, won) {
    const s = w.stats
    endTitle.textContent = won ? 'SECTOR SECURED' : 'OVERRUN'
    endTitle.className = won ? 'aov-title win' : 'aov-title fail'
    endGrade.textContent = gradeFor(w, won)
    vals[0].textContent = s.peakCount
    vals[1].textContent = s.kills
    vals[2].textContent = `${s.bubblesTaken} / ${s.bubblesTaken + s.bubblesMissed}`
    vals[3].textContent = s.barrelsBreached
    vals[4].textContent = WEAPONS[clamp(w.tier, 0, WEAPONS.length - 1)].name
    show(2)
  }

  /** Fully out of the way: display:none can never intercept a drag. */
  function hide() {
    mode = 0
    root.style.display = 'none'
    startCard.style.display = 'none'
    endCard.style.display = 'none'
  }

  function trigger() {
    if (mode === 0 || performance.now() < armedAt) return
    const m = mode
    // Hide FIRST: the callback starts the run synchronously, and its first frame
    // must already be looking at a clear screen. It also makes re-entry a no-op.
    hide()
    if (m === 1) { if (onStart) onStart() }
    else if (onRestart) onRestart()
  }

  function onPointer(e) {
    if (mode === 0) return
    e.preventDefault()
    trigger()
  }

  function onKey(e) {
    if (mode === 0) return
    const k = e.key
    if (k === 'r' || k === 'R' || k === ' ' || k === 'Enter') {
      e.preventDefault()
      trigger()
    }
  }

  // pointerdown, not click: a click waits for the release and adds ~80ms of
  // dead air to the one interaction the whole loop is built around.
  scrim.addEventListener('pointerdown', onPointer)
  window.addEventListener('keydown', onKey)

  function reset() {
    hide()
  }

  function dispose() {
    scrim.removeEventListener('pointerdown', onPointer)
    window.removeEventListener('keydown', onKey)
    if (scrim.parentNode) scrim.parentNode.removeChild(scrim)
  }

  hide()
  return { showStart, showEnd, hide, reset, dispose }
}
