// The flight's panels (port of FlightHUD.swift, rearranged for the web):
//   status   – below the gaze before lift-off: look up, the countdown.
//   gauge    – to the right once airborne: the altitude, a rocket climbing a
//              trajectory line marked with heights, Pause and Exit.
//   controls – to the left once airborne: climb/descend, move, rotate. Hold a
//              button to keep moving.
// Plus the place card.

import { Panel } from './panel.js';

export function altitudeString(m) {
  if (m < 1000) return `${m.toFixed(0)} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

const TOP = 40_000_000;
const MARKS = [
  [0, 'Ground', ''], [1000, '1 km', ''], [10_000, '10 km', 'Airliners'], [100_000, '100 km', 'Space'],
  [400_000, '400 km', 'ISS'], [35_786_000, '35,786 km', 'GEO'],
];
/** Height on the gauge, 0 at the ground, 1 at the top: log scale, with the
 *  long empty stretch above the space station squeezed into the last 15%. */
const L = (m) => Math.log10(1 + Math.max(0, m) / 10);
const L_ISS = L(400_000), L_TOP = L(TOP);
const gaugePos = (m) => (L(m) <= L_ISS ? 0.85 * L(m) / L_ISS : 0.85 + 0.15 * (L(m) - L_ISS) / (L_TOP - L_ISS));

/** Which console parts the user wants: the altitude gauge (the rocket on
 *  its trajectory) and the control cluster. Either can be folded away to a
 *  small tab, from the launch page or from the panel itself; the choice is
 *  remembered across flights. */
const PREF_KEY = 'ascent.console';
export function loadShown() {
  const shown = { gauge: true, controls: true };
  try { Object.assign(shown, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
  return shown;
}
export function saveShown(shown) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(shown)); } catch {}
}

export class HUD {
  constructor() {
    this.status = new Panel(0.5, 'status');
    // Sized for gaze + pinch: the smallest targets come out around 5–6 cm.
    this.gauge = new Panel(0.25, 'gauge', { bare: true, dpr: 2 });
    this.controls = new Panel(0.36, 'controls', { bare: true, dpr: 2 });
    this.confirming = false;
    this.shown = loadShown();
    this.panels = [this.status, this.gauge, this.controls];
  }

  hint(s) {
    if (s.phase === 'arrived') return 'Geostationary orbit.';
    if (s.paused) return 'Paused: use the controls to fly.';
    if (s.altitude < 3000) return s.homeName ? `Look down: that's ${s.homeName}.` : "Look down: that's where you live.";
    if (s.altitude < 60_000) return 'Climbing through the atmosphere.';
    if (s.altitude < 1_000_000) return 'Pinch a label to learn about a place.';
    return 'Heading for geostationary orbit.';
  }

  /** `s`: { phase, countdown, altitude, paused, homeName }. */
  draw(s) {
    const airborne = s.phase === 'ascending' || s.phase === 'arrived';
    this.status.group.visible = !airborne;
    // The console is there from the start; it flies once airborne.
    this.gauge.group.visible = true;
    this.controls.group.visible = true;
    if (!airborne) this.drawStatus(s);
    this.drawGauge(s); this.drawControls(s);
  }

  drawStatus(s) {
    const P = this.status;
    const key = [s.phase, s.countdown, this.confirming, P.pressed].join('|');
    P.render(key, (c) => {
      if (this.confirming) return this.confirmation(c);
      switch (s.phase) {
        case 'intro':
          c.text('↑', 120, { weight: 700, gap: 4 });
          c.text('Look up at the ceiling', 66, { weight: 700 });
          c.text('A portal will open above you.', 50, { color: 'rgba(255,255,255,0.7)', gap: 40 });
          break;
        case 'portal':
          c.text(s.countdown > 3 ? 'Engines starting' : 'Lift-off in', 54, { weight: 700, gap: 0 });
          c.text(String(Math.max(1, s.countdown)), 190, { weight: 800, gap: 6 });
          c.text('Stay where you are and look up at the portal.', 50, { color: 'rgba(255,255,255,0.7)', gap: 40 });
          break;
        default:
          c.text('Lift-off', 120, { weight: 800 });
          c.text('Keep looking up.', 50, { color: 'rgba(255,255,255,0.7)', gap: 40 });
      }
      c.buttons([{ id: 'confirm', label: '✕  Exit', style: 'secondary' }]);
      return c.end();
    });
  }

  confirmation(c) {
    c.text('End the flight?', 62, { weight: 700 });
    c.text("You'll return to the start.", 46, { color: 'rgba(255,255,255,0.7)', gap: 40 });
    c.buttons([{ id: 'keep', label: 'Keep flying', style: 'primary' }], { minW: 380, after: 26 });
    c.buttons([{ id: 'end', label: 'End flight', style: 'destructive' }], { minW: 380 });
    return c.end();
  }

  drawGauge(s) {
    const P = this.gauge;
    if (!this.shown.gauge) return P.render(['gauge-folded', P.pressed].join('|'), (c) => tab(c, 'showGauge', 'Altitude', 14, 200));
    const alt = altitudeString(s.altitude);
    const pos = gaugePos(s.altitude);
    const key = [alt, Math.round(pos * 600), s.paused, s.phase, P.pressed === 'hideGauge'].join('|');
    P.render(key, (c) => {
      const H = 760;
      if (!c.measuring) drawTrajectory(c.g, c.W, H, pos, alt, s.phase === 'arrived' ? 'In orbit' : s.paused ? 'Paused' : '');
      // Fold-away tab under the strip, in the strip's own column.
      return foldButton(c, 'hideGauge', H, 14, 176);
    });
  }

  drawControls(s) {
    const P = this.controls;
    if (!this.shown.controls) return P.render(['ctl-folded', P.pressed].join('|'), (c) => tab(c, 'showControls', 'Controls', 20, 240));
    const key = ['ctl', P.pressed, s.paused, s.phase, this.confirming, s.dragHint].join('|');
    P.render(key, (c) => {
      if (this.confirming) return drawConfirm(c);
      const H = drawControlCluster(c, P.pressed, s);
      return foldButton(c, 'hideControls', H, 20, 496);
    });
  }
}

/** A folded panel: one small glass tab that brings it back. Returns the height. */
function tab(c, id, label, x, w) {
  const h = 56, y = 10;
  c.panel.buttons.push({ id, x, y, w, h });
  if (c.measuring) return y + h + 10;
  const g = c.g, p = pill(x, y, w, h);
  glass(g, p, { strength: 0.8 });
  if (c.panel.pressed === id) glow(g, p);
  chevron(g, x + 30, y + h / 2 + 2, 9, 0, 'rgba(255,255,255,0.9)', 4);
  caption(g, label, x + 52, y + h / 2 + 1, { size: 17, alpha: 0.85, align: 'left' });
  return y + h + 10;
}

/** A slim "Hide" row below a panel's content at `top`. Returns the new height. */
function foldButton(c, id, top, x, w) {
  const h = 50, y = top + 4;
  c.panel.buttons.push({ id, x, y, w, h });
  if (c.measuring) return y + h + 10;
  const g = c.g, p = pill(x, y, w, h);
  glass(g, p, { strength: 0.6 });
  if (c.panel.pressed === id) glow(g, p);
  chevron(g, x + w / 2 - 34, y + h / 2 + 2, 8, Math.PI, 'rgba(255,255,255,0.8)', 4);
  caption(g, 'Hide', x + w / 2 + 10, y + h / 2 + 1, { size: 16, alpha: 0.7 });
  return y + h + 10;
}

// ---------------------------------------------------------------------------
// Drawing. Everything is vector, drawn at 2× for crisp edges up close.

const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif';
const ACCENT = '#7cc4ff';

/** Frosted glass shape with a soft drop shadow and a top highlight. */
function glass(g, path, { strength = 1 } = {}) {
  g.save();
  // visionOS glass: a light, neutral grey frost rather than dark smoke.
  g.shadowColor = 'rgba(0, 0, 0, 0.28)'; g.shadowBlur = 30; g.shadowOffsetY = 10;
  const b = path.bounds;
  const fill = g.createLinearGradient(0, b.y, 0, b.y + b.h);
  fill.addColorStop(0, `rgba(128, 132, 142, ${0.46 * strength})`);
  fill.addColorStop(1, `rgba(72, 76, 86, ${0.5 * strength})`);
  g.fillStyle = fill;
  path.draw(g); g.fill();
  g.restore();
  g.save();
  const edge = g.createLinearGradient(0, b.y, 0, b.y + b.h);
  edge.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
  edge.addColorStop(0.5, 'rgba(255, 255, 255, 0.10)');
  edge.addColorStop(1, 'rgba(255, 255, 255, 0.18)');
  g.strokeStyle = edge; g.lineWidth = 2.5;
  path.draw(g); g.stroke();
  g.restore();
}
const circle = (cx, cy, r) => ({ bounds: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, draw: (g) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); } });
const pill = (x, y, w, h, r = Math.min(w, h) / 2) => ({ bounds: { x, y, w, h }, draw: (g) => { g.beginPath(); g.roundRect(x, y, w, h, r); } });

/** Pressed highlight: accent fill clipped to `path` (and to `rect` [x, y, w, h]). */
function glow(g, path, rect) {
  g.save();
  path.draw(g); g.clip();
  if (rect) { g.beginPath(); g.rect(...rect); g.clip(); }
  const b = path.bounds;
  const rg = g.createRadialGradient(b.x + b.w / 2, b.y + b.h / 2, 0, b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) / 1.3);
  // visionOS-style press: the control lights up white.
  rg.addColorStop(0, 'rgba(255, 255, 255, 0.55)'); rg.addColorStop(1, 'rgba(255, 255, 255, 0.18)');
  g.fillStyle = rg; g.fillRect(b.x, b.y, b.w, b.h);
  g.restore();
}

function chevron(g, cx, cy, size, angle, color = 'rgba(255,255,255,0.95)', width = 7) {
  g.save(); g.translate(cx, cy); g.rotate(angle);
  g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6;
  g.beginPath(); g.moveTo(-size, size * 0.5); g.lineTo(0, -size * 0.5); g.lineTo(size, size * 0.5); g.stroke();
  g.restore();
}

function caption(g, text, x, y, { size = 17, alpha = 0.6, align = 'center', weight = 600 } = {}) {
  g.save();
  g.font = `${weight} ${size}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = '2px';
  g.fillStyle = `rgba(255,255,255,${alpha})`; g.textAlign = align; g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), x, y);
  g.restore();
}

/** Left HUD: a round direction pad, a climb/descend pill, turn, pause, end. */
function drawControlCluster(c, pressed, s) {
  const g = c.g, btn = (id, x, y, w, h) => c.panel.buttons.push({ id, x, y, w, h });
  const cx = 168, cy = 168, R = 148, hub = 58;
  // Direction pad
  btn('fwd', cx - 62, cy - R, 124, R - hub); btn('back', cx - 62, cy + hub, 124, R - hub);
  btn('left', cx - R, cy - 62, R - hub, 124); btn('right', cx + hub, cy - 62, R - hub, 124);
  btn('up', 350, 20, 124, 150); btn('down', 350, 170, 124, 150);
  btn('rotl', 20, 352, 148, 84); btn('rotr', 168, 352, 148, 84);
  btn(s.phase === 'arrived' ? 'again' : 'pause', 342, 352, 84, 84); btn('confirm', 432, 352, 84, 84);
  const H = s.dragHint ? 540 : 456;
  if (c.measuring) return H;
  if (s.dragHint) {
    glass(g, pill(20, 466, 496, 64, 32), { strength: 0.8 });
    g.save(); g.font = `600 25px ${FONT}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Or pinch anywhere and drag to fly', 268, 499); g.restore();
  }

  const pad = circle(cx, cy, R);
  glass(g, pad);
  const dirs = { fwd: -Math.PI / 2, right: 0, back: Math.PI / 2, left: Math.PI };
  for (const [id, a] of Object.entries(dirs)) {
    if (pressed === id) glow(g, { bounds: pad.bounds, draw: (gg) => { gg.beginPath(); gg.arc(cx, cy, R, a - Math.PI / 4, a + Math.PI / 4); gg.arc(cx, cy, hub, a + Math.PI / 4, a - Math.PI / 4, true); gg.closePath(); } });
    chevron(g, cx + Math.cos(a) * 104, cy + Math.sin(a) * 104, 20, a + Math.PI / 2, pressed === id ? '#fff' : 'rgba(255,255,255,0.9)');
  }
  // Hub and the dividing lines between the four segments
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 2;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * hub, cy + Math.sin(a) * hub); g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); g.stroke();
  }
  g.fillStyle = 'rgba(10, 12, 18, 0.35)'; g.beginPath(); g.arc(cx, cy, hub, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.16)'; g.stroke();
  g.restore();
  caption(g, 'Move', cx, cy, { size: 19, alpha: 0.7 });

  // Climb / descend
  const alt = pill(350, 20, 124, 300, 62);
  glass(g, alt);
  if (pressed === 'up') glow(g, alt, [350, 20, 124, 150]);
  if (pressed === 'down') glow(g, alt, [350, 170, 124, 150]);
  chevron(g, 412, 78, 22, 0); chevron(g, 412, 104, 22, 0, 'rgba(255,255,255,0.55)');
  chevron(g, 412, 236, 22, Math.PI, 'rgba(255,255,255,0.55)'); chevron(g, 412, 262, 22, Math.PI);
  g.save(); g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; g.beginPath(); g.moveTo(372, 170); g.lineTo(452, 170); g.stroke(); g.restore();
  caption(g, 'Climb', 412, 140, { size: 18, alpha: 0.75 });
  caption(g, 'Down', 412, 200, { size: 18, alpha: 0.75 });

  // Turn
  const turn = pill(20, 352, 296, 84);
  glass(g, turn);
  if (pressed === 'rotl') glow(g, turn, [20, 352, 148, 84]);
  if (pressed === 'rotr') glow(g, turn, [168, 352, 148, 84]);
  turnArrow(g, 74, 394, 1); turnArrow(g, 262, 394, -1);   // ↺ turns left, ↻ right
  caption(g, 'Turn', 168, 394, { size: 18, alpha: 0.75 });

  // Pause / again, and end
  const first = s.phase === 'arrived' ? 'again' : 'pause';
  for (const [id, x] of [[first, 384], ['confirm', 474]]) {
    const b = circle(x, 394, 40);
    glass(g, b);
    if (pressed === id) glow(g, b);
    g.save(); g.fillStyle = g.strokeStyle = '#fff'; g.lineWidth = 6; g.lineCap = 'round';
    if (id === 'pause' && !s.paused) { g.beginPath(); g.roundRect(x - 13, 380, 9, 28, 3); g.roundRect(x + 4, 380, 9, 28, 3); g.fill(); }
    else if (id === 'pause') { g.beginPath(); g.moveTo(x - 9, 379); g.lineTo(x + 14, 394); g.lineTo(x - 9, 409); g.closePath(); g.fill(); }
    else if (id === 'again') turnArrow(g, x, 394, 1, 15);
    else { g.beginPath(); g.moveTo(x - 11, 383); g.lineTo(x + 11, 405); g.moveTo(x + 11, 383); g.lineTo(x - 11, 405); g.stroke(); }
    g.restore();
  }
  return H;
}

function turnArrow(g, cx, cy, dir, r = 20) {
  g.save(); g.translate(cx, cy); if (dir < 0) g.scale(-1, 1);
  g.strokeStyle = '#fff'; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6;
  g.beginPath(); g.arc(0, 0, r, -Math.PI * 0.85, Math.PI * 0.45); g.stroke();
  const ex = Math.cos(-Math.PI * 0.85) * r, ey = Math.sin(-Math.PI * 0.85) * r;
  g.beginPath(); g.moveTo(ex - 2, ey - 11); g.lineTo(ex, ey + 1); g.lineTo(ex + 12, ey - 3); g.stroke();
  g.restore();
}

function drawConfirm(c) {
  const g = c.g, btn = (id, x, y, w, h) => c.panel.buttons.push({ id, x, y, w, h });
  btn('keep', 40, 150, 210, 84); btn('end', 266, 150, 210, 84);
  if (c.measuring) return 270;
  glass(g, pill(10, 10, 496, 250, 44));
  g.save(); g.font = `700 40px ${FONT}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('End the flight?', 258, 62);
  g.font = `400 24px ${FONT}`; g.fillStyle = 'rgba(255,255,255,0.65)'; g.fillText('You will return to the start.', 258, 106);
  g.restore();
  const keep = pill(40, 150, 210, 84), end = pill(266, 150, 210, 84);
  glass(g, keep); glow(g, keep);
  glass(g, end);
  g.save(); g.font = `600 30px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#fff'; g.fillText('Keep flying', 145, 193);
  g.fillStyle = '#ff9b8f'; g.fillText('End', 371, 193);
  g.restore();
  return 270;
}

/** Right HUD: a slim glowing trajectory from the ground to GEO, height marks
 *  on the left, the rocket on the line and its altitude in a tag beside it. */
function drawTrajectory(g, W, H, pos, alt, note) {
  const lx = 172, top = 40, bottom = H - 50;
  const at = (p) => bottom - p * (bottom - top);
  const ry = at(Math.min(1, pos));
  // A slim glass strip behind the marks and the line, so they read over a
  // bright city as well as over space.
  glass(g, pill(14, top - 26, lx + 18 - 14, bottom - top + 52, 34), { strength: 0.85 });
  g.save();
  g.lineCap = 'round';
  // Track ahead: hairline
  g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(lx, top); g.lineTo(lx, ry); g.stroke();
  // Flown: glowing
  g.shadowColor = 'rgba(124, 196, 255, 0.9)'; g.shadowBlur = 16;
  const grd = g.createLinearGradient(0, bottom, 0, ry);
  grd.addColorStop(0, 'rgba(90, 160, 255, 0.5)'); grd.addColorStop(1, 'rgba(200, 235, 255, 1)');
  g.strokeStyle = grd; g.lineWidth = 6;
  g.beginPath(); g.moveTo(lx, bottom); g.lineTo(lx, ry); g.stroke();
  g.restore();
  // Marks
  for (const [m, label, what] of MARKS) {
    const my = at(gaugePos(m)), passed = gaugePos(m) <= pos + 1e-6;
    if (Math.abs(my - ry) < 26) continue;      // the rocket is here
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 8;
    g.fillStyle = passed ? ACCENT : 'rgba(255,255,255,0.7)';
    g.beginPath(); g.arc(lx, my, passed ? 6 : 5, 0, Math.PI * 2); g.fill();
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.font = `600 26px ${FONT}`; g.fillStyle = passed ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.78)';
    g.fillText(label, lx - 20, what ? my - 10 : my);
    g.restore();
    if (what) caption(g, what, lx - 20, my + 16, { size: 15, alpha: passed ? 0.8 : 0.6, align: 'right' });
  }
  drawRocket(g, lx, ry);
  // Altitude tag riding with the rocket
  g.save();
  g.font = `700 32px ${FONT}`;
  const tw = g.measureText(alt).width, tagW = tw + 40, tagH = note ? 76 : 58;
  const tx = lx + 34, ty = Math.max(8, Math.min(H - tagH - 8, ry - tagH / 2));
  g.restore();
  const tag = pill(tx, ty, tagW, tagH, 22);
  glass(g, tag);
  g.save();
  g.strokeStyle = 'rgba(124, 196, 255, 0.7)'; g.lineWidth = 2; tag.draw(g); g.stroke();
  g.font = `700 32px ${FONT}`; g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(alt, tx + 20, ty + (note ? 28 : tagH / 2 + 1));
  g.restore();
  if (note) caption(g, note, tx + 20, ty + 56, { size: 13, alpha: 0.75, align: 'left' });
}

/** A sleek rocket, nose up, with a flame and a soft glow. */
function drawRocket(g, cx, cy) {
  g.save();
  g.translate(cx, cy);
  const glowG = g.createRadialGradient(0, 0, 2, 0, 0, 54);
  glowG.addColorStop(0, 'rgba(124,196,255,0.55)'); glowG.addColorStop(1, 'rgba(124,196,255,0)');
  g.fillStyle = glowG; g.beginPath(); g.arc(0, 0, 54, 0, Math.PI * 2); g.fill();
  // Flame
  const fl = g.createLinearGradient(0, 16, 0, 58);
  fl.addColorStop(0, 'rgba(255,248,225,1)'); fl.addColorStop(0.35, 'rgba(255,186,90,0.95)'); fl.addColorStop(1, 'rgba(255,110,40,0)');
  g.fillStyle = fl; g.beginPath(); g.moveTo(-8, 18); g.quadraticCurveTo(0, 64, 8, 18); g.closePath(); g.fill();
  // Fins
  g.fillStyle = '#d9e4f2';
  g.beginPath(); g.moveTo(-9, 2); g.quadraticCurveTo(-22, 12, -20, 24); g.lineTo(-9, 18); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(9, 2); g.quadraticCurveTo(22, 12, 20, 24); g.lineTo(9, 18); g.closePath(); g.fill();
  // Body: brushed metal
  const body = g.createLinearGradient(-11, 0, 11, 0);
  body.addColorStop(0, '#9aa7b8'); body.addColorStop(0.45, '#ffffff'); body.addColorStop(1, '#b7c3d3');
  g.fillStyle = body;
  g.beginPath(); g.moveTo(0, -38); g.bezierCurveTo(13, -24, 12, 4, 9, 20); g.lineTo(-9, 20); g.bezierCurveTo(-12, 4, -13, -24, 0, -38); g.closePath(); g.fill();
  // Nose and window
  g.fillStyle = ACCENT; g.beginPath(); g.moveTo(0, -38); g.bezierCurveTo(6, -32, 9, -26, 10, -22); g.lineTo(-10, -22); g.bezierCurveTo(-9, -26, -6, -32, 0, -38); g.closePath(); g.fill();
  g.fillStyle = '#1d2a3f'; g.beginPath(); g.arc(0, -8, 4.5, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(124,196,255,0.9)'; g.lineWidth = 1.5; g.stroke();
  g.restore();
}

export class PlaceCard {
  constructor() {
    this.panel = new Panel(0.62, 'card');
    this.place = null; this.summary = null; this.failed = false; this.image = null;
  }
  get group() { return this.panel.group; }

  show(place, summaryPromise) {
    this.place = place; this.summary = null; this.failed = false; this.image = null;
    const id = place.id;
    summaryPromise.then((s) => {
      if (this.place?.id !== id) return;
      this.summary = s;
      if (s.image) {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { if (this.place?.id === id) { this.image = img; this.panel.key = ''; } };
        img.src = s.image;
      }
    }, () => { if (this.place?.id === id) this.failed = true; });
  }

  draw() {
    if (!this.place) return;
    const s = this.summary;
    const key = [this.place.id, !!s, this.failed, !!this.image, this.panel.pressed].join('|');
    this.panel.render(key, (c) => {
      if (this.image) c.image(this.image, 560);
      c.text(s?.title || this.place.title, 70, { weight: 700, gap: 6 });
      c.text(s?.description || this.place.subtitle || '', 46, { color: 'rgba(255,255,255,0.7)', gap: 26 });
      if (s) c.text(s.extract, 42, { align: 'left', maxLines: 9, gap: 36 });
      else c.text(this.failed ? 'No description available.' : 'Loading…', 42, { color: 'rgba(255,255,255,0.6)', gap: 36 });
      c.buttons([{ id: 'close', label: 'Close', style: 'primary' }], { minW: 460 });
      c.text('or pinch anywhere outside the card', 34, { color: 'rgba(255,255,255,0.5)', gap: 10 });
      return c.end();
    });
  }
}
