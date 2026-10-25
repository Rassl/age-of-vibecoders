// Canvas-drawn glass panels inside the 3D scene: the flight HUD and the
// place card. WebXR has no DOM inside the headset, so each panel is redrawn
// into a texture when its content changes, and buttons are hit-tested by the
// UV where a pointer ray meets the panel.

import * as THREE from 'three';

const PX_PER_M = 1800;
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif';

export class Panel {
  /** `hud`: no glass, a faint backing and shadowed text. `bare`: no backing
   *  at all (the layout draws everything). `dpr`: canvas pixels per layout
   *  pixel, for crisper text up close. */
  constructor(widthM, name, { hud = false, bare = false, dpr = 1 } = {}) {
    this.widthM = widthM;
    this.hud = hud; this.bare = bare; this.dpr = dpr;
    this.W = Math.round(widthM * PX_PER_M);
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = 64;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 30;
    this.mesh.name = name;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.buttons = [];
    this.pressed = null;
    this.key = '';
  }

  /** Redraws when `key` changes. `layout(ctx)` draws and returns the height in px. */
  render(key, layout) {
    if (key === this.key) return;
    this.key = key;
    const c = this.canvas, W = this.W, dpr = this.dpr;
    // Measure pass, then draw at the right height.
    const probe = document.createElement('canvas').getContext('2d');
    this.buttons = [];
    const h = layout(new Ctx(probe, W, this, true));
    this.H = Math.ceil(h);
    const ch = Math.ceil(this.H * dpr);
    // three allocates texture storage once (immutable size): a taller or
    // shorter canvas needs a fresh texture, or the old image stays stretched.
    if (c.height !== ch) { c.height = ch; this.texture.dispose(); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, this.H);
    if (this.bare) {
      // nothing: the layout draws its own backing
    } else if (this.hud) {
      // Just enough backing to read against a bright sky.
      const grd = g.createLinearGradient(0, 0, 0, this.H);
      grd.addColorStop(0, 'rgba(8, 12, 20, 0.30)'); grd.addColorStop(1, 'rgba(8, 12, 20, 0.22)');
      g.fillStyle = grd;
      g.beginPath(); g.roundRect(0, 0, W, this.H, 40); g.fill();
      g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 10;
    } else {
      // Glass background
      g.fillStyle = 'rgba(30, 32, 38, 0.78)';
      g.beginPath(); g.roundRect(0, 0, W, this.H, 46); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 3; g.stroke();
    }
    this.buttons = [];
    layout(new Ctx(g, W, this, false));
    this.texture.needsUpdate = true;
    const hM = (this.H / W) * this.widthM;
    this.mesh.scale.set(this.widthM, hM, 1);
  }

  /** Button id under the ray, or null. */
  hitTest(ray) {
    if (!this.group.visible) return null;
    const rc = new THREE.Raycaster(ray.origin, ray.direction);
    const hit = rc.intersectObject(this.mesh, false)[0];
    if (!hit) return null;
    const x = hit.uv.x * this.W, y = (1 - hit.uv.y) * this.H;
    const b = this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return b ? b.id : 'panel';
  }
}

/** Minimal vertical layout helper. */
class Ctx {
  constructor(g, W, panel, measuring) { this.g = g; this.W = W; this.y = 56; this.panel = panel; this.measuring = measuring; this.pad = 70; }

  text(str, size, { weight = 400, color = '#fff', gap = 14, align = 'center', maxLines = 6 } = {}) {
    const g = this.g;
    g.font = `${weight} ${size}px ${FONT}`;
    const lines = wrap(g, str, this.W - this.pad * 2).slice(0, maxLines);
    const lh = size * 1.25;
    if (!this.measuring) {
      g.fillStyle = color; g.textAlign = align; g.textBaseline = 'top';
      const x = align === 'center' ? this.W / 2 : this.pad;
      lines.forEach((l, i) => g.fillText(l, x, this.y + i * lh));
    }
    this.y += lines.length * lh + gap;
  }

  space(h) { this.y += h; }

  image(img, h) {
    if (!this.measuring && img) {
      const w = this.W - this.pad * 2, ar = img.width / img.height;
      let sw = img.width, sh = img.height, sx = 0, sy = 0;
      if (ar > w / h) { sw = img.height * (w / h); sx = (img.width - sw) / 2; } else { sh = img.width / (w / h); sy = (img.height - sh) / 2; }
      this.g.save(); this.g.beginPath(); this.g.roundRect(this.pad, this.y, w, h, 28); this.g.clip();
      this.g.drawImage(img, sx, sy, sw, sh, this.pad, this.y, w, h); this.g.restore();
    }
    this.y += h + 30;
  }

  /** Reserves `h` px and lets `draw(g, x, y, w, h)` paint into it. */
  custom(h, draw) {
    if (!this.measuring) draw(this.g, this.pad, this.y, this.W - this.pad * 2, h);
    this.y += h;
  }

  /** A row of buttons: [{ id, label, style: 'primary'|'secondary'|'destructive' }]. */
  buttons(list, { gap = 28, minW = 260, h = 118, fs = 46, after = 56 } = {}) {
    const g = this.g;
    g.font = `600 ${fs}px ${FONT}`;
    const widths = list.map((b) => b.w || Math.max(minW, g.measureText(b.label).width + 110));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (list.length - 1);
    let x = (this.W - total) / 2;
    list.forEach((b, i) => {
      const w = widths[i];
      const r = { id: b.id, x, y: this.y, w, h };
      this.panel.buttons.push(r);
      if (!this.measuring) {
        const pressed = this.panel.pressed === b.id;
        g.fillStyle = b.style === 'primary' ? (pressed ? '#5aa2ff' : '#2f7cf6') : b.style === 'destructive' ? (pressed ? 'rgba(255,90,80,0.5)' : 'rgba(255,90,80,0.28)') : (pressed ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.16)');
        g.beginPath(); g.roundRect(x, this.y, w, h, h / 2); g.fill();
        g.fillStyle = b.style === 'destructive' ? '#ff8a80' : '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(b.label, x + w / 2, this.y + h / 2 + 2);
      }
      x += w + gap;
    });
    this.y += h + after;
  }

  /** A row of round icon buttons: [{ id, icon, label? }]. */
  iconButtons(list, { size = 120, gap = 26, after = 30, x0 = null } = {}) {
    const g = this.g;
    const total = list.length * size + gap * (list.length - 1);
    let x = x0 ?? (this.W - total) / 2;
    const labelH = list.some((b) => b.label) ? 44 : 0;
    for (const b of list) {
      if (b) {
        this.panel.buttons.push({ id: b.id, x, y: this.y, w: size, h: size + labelH });
        if (!this.measuring) {
          const pressed = this.panel.pressed === b.id, cx = x + size / 2, cy = this.y + size / 2;
          g.save(); g.shadowBlur = 0;
          g.fillStyle = pressed ? 'rgba(150, 205, 255, 0.55)' : 'rgba(255, 255, 255, 0.13)';
          g.beginPath(); g.arc(cx, cy, size / 2 - 3, 0, Math.PI * 2); g.fill();
          g.strokeStyle = pressed ? 'rgba(200, 230, 255, 1)' : 'rgba(255, 255, 255, 0.55)'; g.lineWidth = 4; g.stroke();
          g.restore();
          drawIcon(g, b.icon, cx, cy, size * 0.36, '#fff');
          if (b.label) {
            g.font = `500 32px ${FONT}`; g.fillStyle = 'rgba(255,255,255,0.85)'; g.textAlign = 'center'; g.textBaseline = 'top';
            g.fillText(b.label, cx, this.y + size + 8);
          }
        }
      }
      x += size + gap;
    }
    this.y += size + labelH + after;
  }

  end() { return this.y; }
}

function wrap(g, text, max) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** Line icons, drawn so they all match: centred on (cx, cy), half-size r. */
export function drawIcon(g, name, cx, cy, r, color) {
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = g.fillStyle = color;
  g.lineWidth = r * 0.22; g.lineCap = 'round'; g.lineJoin = 'round';
  const tri = (a) => { g.save(); g.rotate(a); g.beginPath(); g.moveTo(0, -r * 0.75); g.lineTo(r * 0.75, r * 0.45); g.lineTo(-r * 0.75, r * 0.45); g.closePath(); g.fill(); g.restore(); };
  const chev = (y) => { g.beginPath(); g.moveTo(-r * 0.7, y + r * 0.35); g.lineTo(0, y - r * 0.35); g.lineTo(r * 0.7, y + r * 0.35); g.stroke(); };
  const arc = (dir) => {
    g.beginPath(); g.arc(0, 0, r * 0.7, dir > 0 ? -Math.PI * 0.35 : Math.PI * 1.35, dir > 0 ? Math.PI * 1.15 : -Math.PI * 0.15, dir < 0); g.stroke();
    const a = dir > 0 ? -Math.PI * 0.35 : Math.PI * 1.35, ex = Math.cos(a) * r * 0.7, ey = Math.sin(a) * r * 0.7;
    g.save(); g.translate(ex, ey); g.rotate(a + (dir > 0 ? 0 : Math.PI)); g.beginPath();
    g.moveTo(-r * 0.32, -r * 0.05); g.lineTo(0, r * 0.32); g.lineTo(r * 0.32, -r * 0.05); g.stroke(); g.restore();
  };
  switch (name) {
    case 'fwd': tri(0); break;
    case 'back': tri(Math.PI); break;
    case 'left': tri(-Math.PI / 2); break;
    case 'right': tri(Math.PI / 2); break;
    case 'climb': chev(-r * 0.3); chev(r * 0.35); break;
    case 'descend': g.rotate(Math.PI); chev(-r * 0.3); chev(r * 0.35); break;
    case 'rotl': arc(-1); break;
    case 'rotr': arc(1); break;
    case 'pause': g.fillRect(-r * 0.5, -r * 0.65, r * 0.34, r * 1.3); g.fillRect(r * 0.16, -r * 0.65, r * 0.34, r * 1.3); break;
    case 'play': g.beginPath(); g.moveTo(-r * 0.45, -r * 0.7); g.lineTo(r * 0.7, 0); g.lineTo(-r * 0.45, r * 0.7); g.closePath(); g.fill(); break;
    case 'exit': g.beginPath(); g.moveTo(-r * 0.55, -r * 0.55); g.lineTo(r * 0.55, r * 0.55); g.moveTo(r * 0.55, -r * 0.55); g.lineTo(-r * 0.55, r * 0.55); g.stroke(); break;
    case 'again': arc(1); break;
  }
  g.restore();
}
