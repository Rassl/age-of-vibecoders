// Places as floating labels (port of Markers.swift). Labels never live in
// the scaled world: each frame every chosen place is projected from its true
// position into the rendered scene and pinned there, scaled with distance so
// it keeps a constant, readable size. Candidates behind the Earth's curve are
// dropped, then a greedy pass by popularity keeps at most MAX_LABELS, each at
// least MIN_SEP apart.

import * as THREE from 'three';
import { EARTH_RADIUS } from './geo.js';

const REFERENCE_DISTANCE = 1.3;
const MAX_RENDER_DISTANCE = 300;   // inside the sky (radius 400)
const MAX_LABELS = 14;
const MIN_SEP = (4.5 * Math.PI) / 180;
const LANDMARK_BAND = [190, 30_000];
const CITY_BAND = [20_000, 60_000_000];
const LANDMARK_LIFT = 60;
const LABEL_H = 0.11;     // metres at the reference distance

export class Markers {
  constructor(frame) {
    this.frame = frame;
    this.root = new THREE.Group();
    this.root.name = 'markers';
    this.places = [];
    this.local = new Map();
    this.labels = new Map();   // id → { group, place }
    this.tick = 0;
    this.frontLimit = null;
  }

  add(list) {
    for (const p of list) {
      if (this.local.has(p.id)) continue;
      const lift = p.kind === 'landmark' ? LANDMARK_LIFT : 0;
      this.local.set(p.id, this.frame.position(p.lat, p.lon, EARTH_RADIUS + lift));
      this.places.push(p);
    }
    const score = (p) => (p.kind === 'landmark' ? 1e12 + p.popularity : p.popularity);
    this.places.sort((a, b) => score(b) - score(a));
  }

  /** Per frame. `nav`: { ascent, eyeLocal, toScene(localPoint) → scene }; `eye`
   *  in scene space; `view` the head's orientation, so the labels stay
   *  parallel to the view and upright for the viewer. */
  update(nav, eye, view) {
    const ascent = nav.ascent, eyeLocal = nav.eyeLocal;
    const centre = new THREE.Vector3(0, -EARTH_RADIUS, 0);
    const rendered = (pl) => nav.toScene(new THREE.Vector3(pl[0], pl[1], pl[2]));

    if (++this.tick % 6 === 0) {
      const picked = [];
      for (const p of this.places) {
        if (picked.length >= MAX_LABELS) break;
        const band = p.kind === 'landmark' ? LANDMARK_BAND : CITY_BAND;
        if (ascent < band[0] || ascent > band[1]) continue;
        const pl = this.local.get(p.id);
        const pv = new THREE.Vector3(...pl);
        const n = pv.clone().sub(centre).normalize();
        if (eyeLocal.clone().sub(pv).dot(n) <= 0) continue;   // over the horizon
        const dir = rendered(pl).sub(eye).normalize();
        // From far out the whole planet is a few degrees wide: space labels further apart.
        const sep = ascent > 5_000_000 ? MIN_SEP * 1.8 : MIN_SEP;
        if (picked.some((x) => Math.acos(Math.min(1, x.dir.dot(dir))) < sep)) continue;
        picked.push({ p, dir });
      }
      const ids = new Set(picked.map((x) => x.p.id));
      for (const [id, l] of this.labels) if (!ids.has(id)) { this.root.remove(l.group); l.dispose(); this.labels.delete(id); }
      for (const { p } of picked) if (!this.labels.has(p.id)) { const l = makeLabel(p); this.labels.set(p.id, l); this.root.add(l.group); }
    }

    for (const [id, l] of this.labels) {
      const to = rendered(this.local.get(id)).sub(eye);
      const dist = to.length();
      if (dist < 1e-3) continue;
      const dir = to.divideScalar(dist);
      let d = Math.min(dist, MAX_RENDER_DISTANCE);
      if (this.frontLimit) d = Math.min(d, this.frontLimit * 0.92);
      const s = d / REFERENCE_DISTANCE;
      l.group.position.copy(eye).addScaledVector(dir, d);
      l.group.scale.setScalar(s);
      l.group.quaternion.copy(view);
    }
  }

  /** Hit test with a ray (scene space); returns the place or null. */
  pick(ray) {
    const rc = new THREE.Raycaster(ray.origin, ray.direction);
    const hits = rc.intersectObjects([...this.labels.values()].map((l) => l.hit), false);
    if (!hits.length) return null;
    for (const l of this.labels.values()) if (l.hit === hits[0].object) return l.place;
    return null;
  }

  setPressed(place) {
    for (const l of this.labels.values()) l.setActive(l.place === place);
  }
}

/** A capsule with the place's name, a stem and a dot pinned to the coordinate. */
function makeLabel(place) {
  const scale = 4;
  const font = `600 ${22 * scale}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const sub = `400 ${15 * scale}px -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font; const tw = meas.measureText(place.title).width;
  const subtitle = place.kind === 'city' ? place.subtitle : (place.subtitle || '').slice(0, 40);
  meas.font = sub; const sw = subtitle ? meas.measureText(subtitle).width : 0;
  const padX = 22 * scale, capH = (subtitle ? 64 : 46) * scale;
  const W = Math.ceil(Math.max(tw, sw) + padX * 2), stem = 34 * scale, H = Math.ceil(capH + stem + 12 * scale);

  const draw = (active) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const r = capH / 2;
    g.fillStyle = active ? 'rgba(255,255,255,0.92)' : 'rgba(28,30,36,0.72)';
    g.beginPath(); g.roundRect(1, 1, W - 2, capH - 2, r); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2 * scale; g.stroke();
    g.fillStyle = active ? '#111' : '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = font; g.fillText(place.title, W / 2, subtitle ? capH * 0.38 : capH / 2);
    if (subtitle) { g.font = sub; g.fillStyle = active ? '#333' : 'rgba(255,255,255,0.72)'; g.fillText(subtitle, W / 2, capH * 0.72); }
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(W / 2 - scale, capH, 2 * scale, stem);
    g.beginPath(); g.arc(W / 2, H - 6 * scale, 5 * scale, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const tex = [draw(false), draw(true)];
  const h = LABEL_H * (H / (46 * scale + 34 * scale + 12 * scale)), w = (h * W) / H;
  const mat = new THREE.MeshBasicMaterial({ map: tex[0], transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.y = h / 2;     // the dot at the bottom sits on the point
  mesh.renderOrder = 20;
  const hitH = h * (capH / H);
  const hit = new THREE.Mesh(new THREE.PlaneGeometry(w, hitH), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = h - hitH / 2;
  const group = new THREE.Group();
  group.add(mesh, hit);
  return {
    group, hit, place,
    setActive(a) { mat.map = tex[a ? 1 : 0]; },
    dispose() { tex.forEach((t) => t.dispose()); mat.dispose(); mesh.geometry.dispose(); hit.geometry.dispose(); },
  };
}
