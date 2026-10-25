// 3D buildings around the start point, extruded from OpenStreetMap
// footprints via Overpass (port of BuildingLayer.swift). Heights come from
// `height` or `building:levels`, else a default per type. The building
// containing the start point is left out. Results are cached in
// localStorage per rounded coordinate; Overpass servers are raced.

import * as THREE from 'three';
import { SUN_DIRECTION } from './sky.js';

const RADIUS_M = 650;
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const HIDE_ABOVE = 20_000;
const FLOOR_H = 3.4, BAY_W = 3.0;

const inflight = new Map();
/** Same request twice (prefetch, then the flight) shares one fetch. */
export function fetchBuildings(lat, lon) {
  const key = `bld:${lat.toFixed(4)}_${lon.toFixed(4)}`;
  if (!inflight.has(key)) inflight.set(key, load(key, lat, lon).catch((e) => { inflight.delete(key); throw e; }));
  return inflight.get(key);
}

async function load(key, lat, lon) {
  try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch {}
  const query = `[out:json][timeout:40];way["building"](around:${RADIUS_M},${lat},${lon});out geom;`;
  const ctrl = new AbortController();
  const data = await Promise.any(SERVERS.map(async (s) => {
    const r = await fetch(s, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
    if (!r.ok) throw new Error('overpass ' + r.status);
    return r.json();
  }));
  ctrl.abort();
  const list = [];
  for (const e of data.elements || []) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 4) continue;
    const pts = e.geometry.map((n) => [n.lon, n.lat]);
    const f = pts[0], l = pts[pts.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) pts.pop();
    if (pts.length < 3) continue;
    list.push({ points: pts, height: heightFrom(e.tags || {}) });
  }
  try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
  return list;
}

function heightFrom(tags) {
  const num = (s) => { if (!s) return null; const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) && v > 0 ? v : null; };
  const h = num(tags.height); if (h) return h;
  const l = num(tags['building:levels']); if (l) return l * 3.2 + 1;
  switch (tags.building) {
    case 'house': case 'detached': case 'garage': case 'shed': case 'hut': return 5;
    case 'apartments': case 'office': case 'hotel': case 'commercial': return 18;
    default: return 9;
  }
}

const signedArea = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i][0] * p[j][1] - p[j][0] * p[i][1]; } return a / 2; };
function contains(p, q) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > q[1]) !== (p[j][1] > q[1]) && q[0] < ((p[j][0] - p[i][0]) * (q[1] - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  }
  return inside;
}

/** Extrudes footprints into textured buildings, walls shaded by how directly they face the sun. */
export function buildBuildings(list, frame) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const sunXZ = new THREE.Vector2(SUN_DIRECTION.x, SUN_DIRECTION.z).normalize();
  const cosEl = Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z);
  const wp = [], wuv = [], wc = [], wi = [];
  const rp = [], ruv = [], ri = [];

  for (const b of list) {
    let poly = b.points.map(([lo, la]) => { const l = frame.position(la, lo); return [l[0], l[2]]; });
    if (signedArea(poly) < 0) poly.reverse();
    if (Math.abs(signedArea(poly)) <= 1) continue;
    if (contains(poly, [0, 0])) continue;     // the start point's own building
    const h = b.height;
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;

    // Roof: earcut in the XZ plane.
    const tris = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
    const base = rp.length / 3;
    for (const p of poly) { rp.push(p[0], h, p[1]); ruv.push(p[0] / 24, p[1] / 24); }
    for (const t of tris) ri.push(base + t[0], base + t[2], base + t[1]);

    let run = 0;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1], len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      let nx = dz / len, nz = -dx / len;
      if (nx * ((p0[0] + p1[0]) / 2 - cx) + nz * ((p0[1] + p1[1]) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
      const lambert = Math.max(0, nx * sunXZ.x + nz * sunXZ.y) * cosEl;
      const shade = Math.min(1, 0.55 + (0.45 * lambert) / Math.max(cosEl, 0.01));
      const u0 = run / (BAY_W * 8), u1 = (run + len) / (BAY_W * 8), vTop = h / (FLOOR_H * 4);
      const s = wp.length / 3;
      wp.push(p0[0], 0, p0[1], p1[0], 0, p1[1], p1[0], h, p1[1], p0[0], h, p0[1]);
      wuv.push(u0, 0, u1, 0, u1, vTop, u0, vTop);
      for (let k = 0; k < 4; k++) wc.push(shade * 1.02, shade, shade * 0.97);
      wi.push(s, s + 2, s + 1, s, s + 3, s + 2);
      run += len;
    }
  }
  if (wp.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
    g.setIndex(wi);
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: facadeTexture(), vertexColors: true, side: THREE.DoubleSide })));
  }
  if (rp.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
    g.setIndex(ri);
    const shade = 0.45 + 0.5 * SUN_DIRECTION.y;
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: roofTexture(), color: new THREE.Color(shade, shade, shade), side: THREE.DoubleSide })));
  }
  return group;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** 4 floors × 8 bays of curtain wall: tinted glass reflecting the sky, light mullions and spandrels. */
export function facadeTexture() {
  const w = 512, h = 512, bayPx = w / 8, floorPx = h / 4;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  const r = rng(11), pane = Array.from({ length: 32 }, r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x % bayPx, fy = y % floorPx, bay = Math.floor(x / bayPx), floor = Math.floor(y / floorPx);
    let col;
    if (fx < 3 || fx > bayPx - 4 || fy > floorPx - 30) {
      const v = fy > floorPx - 30 ? 0.86 : 0.8; col = [v * 1.02, v, v * 0.96];
    } else {
      const t = fy / (floorPx - 30), p = pane[(floor * 8 + bay) % 32], m = t * 0.8 + p * 0.2;
      col = [0.66 + (0.34 - 0.66) * m, 0.76 + (0.42 - 0.76) * m, 0.86 + (0.52 - 0.86) * m];
      if (p > 0.86) col = [(col[0] + 0.62) / 2, (col[1] + 0.55) / 2, (col[2] + 0.42) / 2];
    }
    const i = (y * w + x) * 4;
    img.data[i] = Math.min(255, col[0] * 255); img.data[i + 1] = col[1] * 255; img.data[i + 2] = col[2] * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

function roofTexture() {
  const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n), r = rng(23);
  const boxes = Array.from({ length: 10 }, () => [r() * 230, r() * 230, 8 + r() * 18, 8 + r() * 18]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0.72 + (r() - 0.5) * 0.1;
    for (const b of boxes) if (x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]) v = 0.5;
    const i = (y * n + x) * 4;
    img.data[i] = v * 255; img.data[i + 1] = v * 250; img.data[i + 2] = v * 242; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
