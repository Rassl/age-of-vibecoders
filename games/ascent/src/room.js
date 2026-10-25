// The virtual room that replaces the real one: a closed, quiet loft with
// real (CC0, Poly Haven) floor and plaster textures, lit by recessed ceiling
// lights. No windows: the city is only revealed once you are through the roof. The portal opens in its ceiling (port of Portal.swift):
// the slab is cut by a shader so the hole irises open, a short shaft gives
// the hole thickness, two counter-rotating glow rings hide the edge, sparks
// fall from the rim and ceiling dust bursts out on opening.

import * as THREE from 'three';

export const ROOM = { w: 6.4, d: 5.6, h: 2.8 };   // x, z, y (metres); centred on the start point
export const PORTAL_RADIUS = 1.1;
const SLAB = 0.3;

/** Poly Haven PBR set. `paint`: drop the colour map and keep only the
 *  plaster's relief (normal + roughness) under a solid paint colour. */
function pbr(base, repeat, opts = {}, paint = null) {
  const tl = new THREE.TextureLoader();
  const t = (suffix, srgb) => {
    const x = tl.load(`assets/room/${base}_${suffix}.jpg`);
    x.wrapS = x.wrapT = THREE.RepeatWrapping; x.repeat.set(repeat[0], repeat[1]); x.anisotropy = 8;
    if (srgb) x.colorSpace = THREE.SRGBColorSpace;
    return x;
  };
  const m = new THREE.MeshStandardMaterial({ normalMap: t('nor_gl'), roughnessMap: t('Rough'), ...opts });
  if (paint) m.color = paint; else m.map = t('Diffuse', true);
  m.normalScale.set(0.6, 0.6);
  return m;
}

export class Room {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'room';
    const { w, d, h } = ROOM;

    const floorMat = pbr('laminate_floor_02', [w / 2.2, d / 2.2], { roughness: 0.9 });
    // Plaster, painted a warm white (the texture itself is beige).
    const white = new THREE.Color().setRGB(0.93, 0.91, 0.87, THREE.SRGBColorSpace);
    const wallMat = pbr('beige_wall_001', [w / 2.5, h / 2.5], {}, white);
    const sideWallMat = pbr('beige_wall_001', [d / 2.5, h / 2.5], {}, white);

    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    // Ceiling slab with the portal cut out of it by the shader.
    this.portalUniforms = { portalR: { value: 0 }, portalTime: { value: 0 } };
    // Ceiling: the same plaster, painted white.
    const ceilMat = pbr('beige_wall_001', [w / 2.5, d / 2.5], {}, new THREE.Color().setRGB(0.96, 0.96, 0.95, THREE.SRGBColorSpace));
    ceilMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.portalUniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vLocal; uniform float portalR, portalTime;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          float a = atan(vLocal.y, vLocal.x);
          float jag = 0.035 * sin(a * 7.0 + portalTime * 0.7) + 0.02 * sin(a * 19.0 - portalTime * 1.3);
          if (length(vLocal.xy) < portalR * (1.0 + jag)) discard;
        }`);
    };
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = h;
    this.root.add(ceiling);
    // Top of the slab (seen from above after lift-off), cut the same way.
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 1 });
    roofMat.onBeforeCompile = ceilMat.onBeforeCompile;
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.4, d + 0.4), roofMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.y = h + SLAB;
    this.root.add(roof);

    // Walls
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    back.position.set(0, h / 2, d / 2); back.rotation.y = Math.PI;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    front.position.set(0, h / 2, -d / 2);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(d, h), sideWallMat);
    left.position.set(-w / 2, h / 2, 0); left.rotation.y = Math.PI / 2;
    const right = new THREE.Mesh(new THREE.PlaneGeometry(d, h), sideWallMat);
    right.position.set(w / 2, h / 2, 0); right.rotation.y = -Math.PI / 2;
    for (const m of [back, front, left, right]) this.root.add(m);

    // Outside of the box, so it reads as a building when seen from above.
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.95 });
    const shell = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + SLAB, d + 0.4), Array(6).fill(shellMat));
    shell.position.y = (h + SLAB) / 2;
    // Outer walls only: no top (the roof is cut by the portal), no bottom.
    shell.geometry.groups = shell.geometry.groups.filter((g, i) => i !== 2 && i !== 3);
    this.root.add(shell);

    // Skirting along the solid walls.
    const skirt = new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.6 });
    for (const [sx, sz, x, z] of [[w, 0.02, 0, d / 2 - 0.01], [w, 0.02, 0, -d / 2 + 0.01], [0.02, d, -w / 2 + 0.01, 0], [0.02, d, w / 2 - 0.01, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.09, sz), skirt); m.position.set(x, 0.045, z); this.root.add(m);
    }

    // A rug and a marked spot to stand on.
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.15, 64), new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = 0.004;
    this.root.add(rug);
    this.padMat = new THREE.MeshBasicMaterial({ map: padTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 });
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), this.padMat);
    pad.rotation.x = -Math.PI / 2; pad.position.y = 0.008;
    this.root.add(pad);

    // Light: four warm recessed downlights and a soft fill. The fixtures
    // are hidden when the portal grows over them.
    this.root.add(new THREE.HemisphereLight(0xf4f1ea, 0xcfc2ae, 0.55));
    this.downlights = [];
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(1, 0.94, 0.84, THREE.SRGBColorSpace) });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd8d6d2, roughness: 0.4, metalness: 0.3 });
    for (const [x, z] of [[-1.75, -1.55], [1.75, -1.55], [-1.75, 1.55], [1.75, 1.55]]) {
      const g = new THREE.Group();
      g.position.set(x, h - 0.003, z);
      const rim = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.085, 32), rimMat); rim.rotation.x = Math.PI / 2;
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.06, 32), glowMat); lens.rotation.x = Math.PI / 2;
      const light = new THREE.SpotLight(0xffe7c8, 9, 9, 1.05, 0.85, 1.6);
      light.position.set(0, -0.02, 0);
      light.target.position.set(0, -h, 0);
      g.add(rim, lens, light, light.target);
      this.root.add(g);
      this.downlights.push({ g, r: Math.hypot(x, z) });
    }
    this.portalLight = new THREE.PointLight(0x9fd0ff, 0, 7, 1.4);
    this.portalLight.position.set(0, h - 0.4, 0);
    this.root.add(this.portalLight);

    this.buildPortal();
  }

  buildPortal() {
    const h = ROOM.h;
    this.portal = new THREE.Group();
    this.portal.position.y = h;
    this.root.add(this.portal);

    // Shaft through the slab.
    const shaftMat = new THREE.MeshBasicMaterial({ map: shaftTexture(), side: THREE.BackSide });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(PORTAL_RADIUS, PORTAL_RADIUS, SLAB, 96, 1, true), shaftMat);
    this.shaft.position.y = SLAB / 2;
    this.portal.add(this.shaft);

    this.rings = [0, 1].map((i) => {
      const outer = i === 0 ? 1.32 : 1.55;
      const m = new THREE.Mesh(new THREE.RingGeometry(PORTAL_RADIUS * 0.78, PORTAL_RADIUS * outer, 128, 1),
        new THREE.MeshBasicMaterial({ map: ringTexture(7 + i * 13, i === 0), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.rotation.x = Math.PI / 2;
      m.position.y = -0.01 - i * 0.004;
      m.renderOrder = 5;
      // RingGeometry UVs are planar over the outer square: matches the polar texture.
      this.portal.add(m);
      return m;
    });

    // Sparks and dust: simple point sprites with CPU motion.
    this.sparks = new Particles(300, 0.012, new THREE.Color(0.85, 0.97, 1), THREE.AdditiveBlending);
    this.dust = new Particles(320, 0.01, new THREE.Color(0.78, 0.77, 0.75), THREE.NormalBlending);
    this.portal.add(this.sparks.points, this.dust.points);
    this.time = 0;
    this.open = 0;
    this.growth = 1;
    this.setOpen(0);
  }

  burstDust() {
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2, r = PORTAL_RADIUS * (0.95 + Math.random() * 0.2);
      this.dust.spawn([Math.cos(a) * r, -0.02, Math.sin(a) * r], [Math.cos(a) * 0.2 * Math.random(), -Math.random() * 0.3, Math.sin(a) * 0.2 * Math.random()], 1.6 + Math.random() * 1.6, -3);
    }
  }

  setOpen(o) { this.open = o; this.applyScale(); }
  setGrowth(g) { this.growth = g; this.applyScale(); }
  applyScale() {
    const s = Math.max(0.001, this.open) * this.growth;
    this.portalUniforms.portalR.value = PORTAL_RADIUS * s;
    this.shaft.scale.set(s, 1, s);
    this.shaft.visible = this.open > 0.01;
    for (const l of this.downlights || []) l.g.visible = l.r > PORTAL_RADIUS * s + 0.2;
    for (const r of this.rings) r.visible = this.open > 0.01;
    this.scaleNow = s;
  }

  update(dt, sparkLevel) {
    this.time += dt;
    this.portalUniforms.portalTime.value = this.time;
    const s = this.scaleNow;
    this.rings.forEach((r, i) => {
      const dir = i === 0 ? 1 : -1;
      r.rotation.z = dir * this.time * (i === 0 ? 0.35 : 0.22);
      const pulse = 1 + 0.03 * Math.sin(this.time * (i === 0 ? 2.3 : 1.7));
      r.scale.setScalar(s * pulse);
    });
    const rate = 90 * sparkLevel * this.open;
    this.sparkAcc = (this.sparkAcc || 0) + rate * dt;
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      const a = Math.random() * Math.PI * 2, r = PORTAL_RADIUS * s;
      this.sparks.spawn([Math.cos(a) * r, -0.01, Math.sin(a) * r], [(Math.random() - 0.5) * 0.3, -0.2 - Math.random() * 0.3, (Math.random() - 0.5) * 0.3], 1.1 + Math.random() * 1.0, -2.2);
    }
    this.sparks.update(dt);
    this.dust.update(dt);
    this.portalLight.intensity = 6 * this.open;
    this.padMat.opacity = 0.35 + 0.25 * Math.sin(this.time * 2.2);
  }
}

/** Tiny CPU particle system for sparks and dust (points, fade with life). */
class Particles {
  constructor(max, size, color, blending) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.age = new Float32Array(max); this.acc = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: color }, size: { value: size } },
      vertexShader: `attribute float alpha; varying float vA; uniform float size;
        void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(size * 900. / -mv.z, 1.5, 14.); }`,
      fragmentShader: `uniform vec3 color; varying float vA;
        void main() { float r = length(gl_PointCoord - .5) * 2.; if (r > 1.) discard; gl_FragColor = vec4(color, vA * (1. - r * r)); }`,
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }
  spawn(p, v, life, accY) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos.set(p, i * 3); this.vel.set(v, i * 3);
    this.life[i] = life; this.age[i] = 0; this.acc[i] = accY;
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.life[i] = 0; this.alpha[i] = 0; continue; }
      this.vel[i * 3 + 1] += this.acc[i] * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      this.alpha[i] = 1 - this.age[i] / this.life[i];
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.alpha.needsUpdate = true;
  }
}

function canvasTex(n, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  draw(c.getContext('2d'), n);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Polar glow with flickering filaments, as Portal.ringTexture. */
function ringTexture(seed, hot) {
  return canvasTex(512, (g, n) => {
    const img = g.createImageData(n, n), r0 = seeded(seed);
    const waves = Array.from({ length: 7 }, () => ({ k: Math.floor(3 + r0() * 37), ph: r0() * 6.28, a: 0.2 + r0() * 0.8 }));
    const edge = (1 / (hot ? 1.32 : 1.55)) * 0.5;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5, dy = (y + 0.5) / n - 0.5, r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      let nz = 0; for (const w of waves) nz += w.a * Math.sin(w.k * ang + w.ph + r * 30);
      nz = 0.5 + nz / 6;
      const d = (r - edge) / 0.5;
      const inner = Math.exp(-Math.pow(Math.max(0, -d) / (hot ? 0.035 : 0.05), 2));
      const outer = Math.exp(-Math.max(0, d) / (hot ? 0.045 : 0.09));
      let a = (d < 0 ? inner : outer) * (0.55 + 0.45 * nz);
      if (!hot) a *= 0.55;
      if (r > 0.5) a = 0;
      const core = Math.exp(-Math.pow(d / 0.012, 2)) * (hot ? 1 : 0.4);
      const m = Math.min(1, core + a * 0.3), A = Math.min(1, a + core);
      const i = (y * n + x) * 4;
      // Additive: bake alpha into colour.
      img.data[i] = (0.25 + 0.75 * m) * 255 * A; img.data[i + 1] = (0.65 + 0.35 * m) * 255 * A; img.data[i + 2] = 255 * A; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

function shaftTexture() {
  const t = canvasTex(256, (g, n) => {
    const img = g.createImageData(n, n), r = seeded(5);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 1 - y / (n - 1);            // 0 top … 1 mouth (canvas y down; cylinder v=1 at top)
      const grain = r();
      const glow = Math.pow(v, 6) * 0.9, gr = 0.18 + 0.12 * grain;
      const c = [gr * (0.5 + 0.5 * v) + 0.35 * glow, gr * (0.5 + 0.5 * v) + 0.7 * glow, gr * 1.05 * (0.5 + 0.5 * v) + glow];
      const i = (y * n + x) * 4;
      img.data[i] = Math.min(1, c[0]) * 255; img.data[i + 1] = Math.min(1, c[1]) * 255; img.data[i + 2] = Math.min(1, c[2]) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1);
  return t;
}

/** Woven wool rug: warm grey with a darker border. */
function rugTexture() {
  return canvasTex(512, (g, n) => {
    const img = g.createImageData(n, n), r = seeded(3);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1, rr = Math.hypot(dx, dy);
      const weave = 0.04 * Math.sin(x * 1.7) * Math.sin(y * 1.9) + (r() - 0.5) * 0.06;
      let v = 0.56 + weave;
      if (rr > 0.86 && rr < 0.93) v -= 0.16;
      const i = (y * n + x) * 4;
      img.data[i] = v * 255; img.data[i + 1] = v * 0.97 * 255; img.data[i + 2] = v * 0.92 * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

/** A soft cyan ring on the floor: "stand here". */
function padTexture() {
  return canvasTex(256, (g, n) => {
    const grd = g.createRadialGradient(n / 2, n / 2, n * 0.36, n / 2, n / 2, n * 0.5);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.35, 'rgba(120,200,255,0.9)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, n, n);
  });
}
