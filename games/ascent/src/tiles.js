// Satellite imagery (Esri World Imagery, keyless, CORS-enabled) laid on the
// sphere around the start point (port of TileLayer.swift / TileMesh.swift).
//
// Levels: the finest zoom z as an 8×8 block (tiles ≈ altitude/3 wide), then
// z−2, z−4, z−6, z−8 as 4×4 blocks, each twice the extent of the one before.
// Coarser levels sit slightly below finer ones so the finer ones cover them.
// `update` takes the current altitude plus look-ahead values so the next
// levels are loading before the zoom steps down.

import * as THREE from 'three';
import { TileKey, EARTH_RADIUS, latFromMercatorY, lonFromMercatorX } from './geo.js';

// Two hostnames serve the same tiles: browsers open ~6 connections per host,
// so alternating doubles the requests in flight.
const HOSTS = ['https://server.arcgisonline.com', 'https://services.arcgisonline.com'];
export const tileURL = (k) => `${HOSTS[(k.x + k.y) & 1]}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${k.z}/${k.y}/${k.x}`;
const FINE_BLOCK = 8, COARSE_BLOCK = 4, LEVEL_STEP = 2, LEVEL_COUNT = 5, MAX_ZOOM = 19;
const MAX_INFLIGHT = 12;   // 6 per host

const segmentsFor = (z) => (z < 3 ? 32 : z < 8 ? 16 : 4);
const insetFor = (z, lat) => Math.min(TileKey.groundSize(z, lat) * 0.002, 20_000);

export class TileLayer {
  constructor(frame, renderer) {
    this.frame = frame;
    this.root = new THREE.Group();
    this.root.name = 'tiles';
    this.tiles = new Map();      // id → mesh
    this.pending = new Set();
    this.wanted = new Set();
    this.queue = [];
    this.inflight = 0;
    this.lastZooms = '';
    this.loaded = 0;
    this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // Plain images (not ImageBitmap): Safari's bitmap options are unreliable.
    this.loader = new THREE.ImageLoader();
    this.loader.setCrossOrigin('anonymous');
    this.opacity = 1;
  }

  /** Finest zoom whose tiles are about a third of the altitude wide. */
  zoomFor(h) {
    const full = 2 * Math.PI * EARTH_RADIUS * Math.cos((this.frame.lat * Math.PI) / 180);
    return Math.min(MAX_ZOOM, Math.max(0, Math.floor(Math.log2((full * 3) / Math.max(h, 1)))));
  }

  /** `centre`: { lat, lon, local } of the ground point under the user. */
  update(altitudes, centre = { lat: this.frame.lat, lon: this.frame.lon, local: [0, 0, 0] }) {
    this.centre = centre;
    const zooms = altitudes.map((h) => this.zoomFor(h));
    const sig = zooms.join(',') + '@' + zooms.map((z) => TileKey.containing(centre.lat, centre.lon, Math.max(0, z - 8)).id).join(',') + TileKey.containing(centre.lat, centre.lon, zooms[0]).id;
    if (sig === this.lastZooms) return;
    this.lastZooms = sig;
    const next = new Map();
    for (const z of zooms) {
      for (let i = 0; i < LEVEL_COUNT; i++) {
        const lz = z - i * LEVEL_STEP;
        if (lz < 0) break;
        for (const k of TileKey.block(centre.lat, centre.lon, lz, i === 0 ? FINE_BLOCK : COARSE_BLOCK)) {
          if (!next.has(k.id)) next.set(k.id, k);
        }
      }
    }
    this.wanted = new Set(next.keys());
    for (const [id, mesh] of this.tiles) {
      if (!this.wanted.has(id)) {
        this.root.remove(mesh);
        mesh.geometry.dispose(); mesh.material.map?.dispose(); mesh.material.dispose();
        this.tiles.delete(id);
      }
    }
    // Biggest-looking first: the tile under the feet and the coarse levels
    // that fill the horizon, then the rest of the fine block outward.
    const h = Math.max(altitudes[0], 1);
    const order = [...next.values()].sort((a, b) => this.priority(b, h) - this.priority(a, h));
    this.queue = order.filter((k) => !this.tiles.has(k.id) && !this.pending.has(k.id));
    this.pump();
  }

  pump() {
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const k = this.queue.shift();
      if (!this.wanted.has(k.id) || this.tiles.has(k.id) || this.pending.has(k.id)) continue;
      this.pending.add(k.id);
      this.inflight++;
      const url = tileURL(k);
      this.loader.load(url, (img) => {
        this.inflight--; this.pending.delete(k.id);
        if (this.wanted.has(k.id) && !this.tiles.has(k.id)) this.add(k, img);
        this.pump();
      }, undefined, () => {
        this.inflight--; this.pending.delete(k.id);
        this.pump();
      });
    }
  }

  add(key, img) {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Clamp: wrapping samples the opposite edge and draws hairlines at borders.
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(8, this.anisotropy);
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: this.opacity < 1, opacity: this.opacity, depthWrite: true });
    const mesh = new THREE.Mesh(this.geometry(key), mat);
    mesh.name = 'tile-' + key.id;
    mesh.renderOrder = -1;
    this.root.add(mesh);
    this.tiles.set(key.id, mesh);
    this.loaded++;
  }

  /** Apparent size of the tile from the eye above the start point. */
  priority(k, h) {
    const lat = latFromMercatorY((k.minY + k.maxY) / 2), lon = lonFromMercatorX((k.minX + k.maxX) / 2);
    const p = this.frame.position(lat, lon), c = this.centre?.local || [0, 0, 0];
    const d = Math.hypot(p[0] - c[0], p[1] - c[1] - h, p[2] - c[2]);
    const size = TileKey.groundSize(k.z, this.frame.lat);
    return size / Math.max(d, size * 0.5);
  }

  setOpacity(o) {
    if (o === this.opacity) return;
    this.opacity = o;
    for (const m of this.tiles.values()) { m.material.opacity = o; m.material.transparent = o < 1; m.material.needsUpdate = true; }
    this.root.visible = o > 0.001;
  }

  /** A tile as a patch of the sphere, relative to the anchor. */
  geometry(key) {
    const seg = segmentsFor(key.z);
    const radius = EARTH_RADIUS - insetFor(key.z, this.frame.lat);
    const pos = new Float32Array((seg + 1) * (seg + 1) * 3);
    const uv = new Float32Array((seg + 1) * (seg + 1) * 2);
    let p = 0, q = 0;
    for (let j = 0; j <= seg; j++) {
      const fy = j / seg;
      const lat = latFromMercatorY(key.minY + (key.maxY - key.minY) * fy);
      for (let i = 0; i <= seg; i++) {
        const fx = i / seg;
        const lon = lonFromMercatorX(key.minX + (key.maxX - key.minX) * fx);
        const l = this.frame.position(lat, lon, radius);
        pos[p++] = l[0]; pos[p++] = l[1]; pos[p++] = l[2];
        uv[q++] = fx; uv[q++] = 1 - fy;   // image row 0 is the north edge
      }
    }
    const idx = [];
    const w = seg + 1;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Warms the HTTP cache with the tiles the start view needs, while the user
 *  is still on the launch page. Returns a cancel function. */
export function prefetchTiles(frame, onProgress) {
  const layer = { frame };
  const zoomFor = TileLayer.prototype.zoomFor.bind(layer);
  const priority = TileLayer.prototype.priority.bind(layer);
  const z = zoomFor(1.6), keys = new Map();
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const lz = z - i * LEVEL_STEP;
    if (lz < 0) break;
    for (const k of TileKey.block(frame.lat, frame.lon, lz, i === 0 ? FINE_BLOCK : COARSE_BLOCK)) keys.set(k.id, k);
  }
  const queue = [...keys.values()].sort((a, b) => priority(b, 1.6) - priority(a, 1.6));
  let cancelled = false, inflight = 0, done = 0;
  const pump = () => {
    while (!cancelled && inflight < MAX_INFLIGHT && queue.length) {
      const k = queue.shift();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      inflight++;
      img.onload = img.onerror = () => { inflight--; done++; onProgress?.(done, keys.size); pump(); };
      img.src = tileURL(k);
    }
  };
  pump();
  return () => { cancelled = true; };
}
