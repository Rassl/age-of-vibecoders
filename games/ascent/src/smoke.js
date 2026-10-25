// Rocket smoke (port of Exhaust.swift). Every puff plays the Mantaflow smoke
// simulation rendered in Blender (fx_smoke.png, 6×6 frames, premultiplied).
// Puffs always face the eye (per eye, in the shader), and fade out softly
// where they meet the room's floor and walls instead of being cut by them.
//
// On the floor (countdown): smoke rolling outward across the floor, then a
// jet blasting down from under the feet. Riding with the user after the
// crossing: a shroud streaming down past them and a long plume below.

import * as THREE from 'three';
import { ROOM } from './room.js';

const GRID = 6, FRAMES = GRID * GRID;
const MAX = 900;

const vertexShader = /* glsl */`
  attribute vec3 iPos; attribute float iSize; attribute float iFrame; attribute float iAlpha; attribute float iRot; attribute float iTint;
  varying vec2 vUv; varying float vAlpha; varying float vTint; varying vec3 vRoom;
  uniform mat4 toRoom;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float c = cos(iRot), s = sin(iRot);
    vec2 o = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSize;
    mv.xy += o;
    gl_Position = projectionMatrix * mv;
    float f = floor(iFrame);
    vec2 cell = vec2(mod(f, ${GRID}.0), floor(f / ${GRID}.0));
    vec2 uv = position.xy + 0.5;
    vUv = vec2((cell.x + uv.x) / ${GRID}.0, 1.0 - (cell.y + 1.0 - uv.y) / ${GRID}.0);
    vAlpha = iAlpha; vTint = iTint;
    vRoom = (toRoom * (inverse(viewMatrix) * mv)).xyz;
  }`;

const fragmentShader = /* glsl */`
  uniform sampler2D map; uniform float softRoom; uniform vec3 roomHalf; uniform vec3 light;
  varying vec2 vUv; varying float vAlpha; varying float vTint; varying vec3 vRoom;
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = vAlpha;
    if (softRoom > 0.5) {
      // Fade before the floor and walls: no straight cut where a puff meets them.
      float df = vRoom.y;
      float dw = min(roomHalf.x - abs(vRoom.x), roomHalf.z - abs(vRoom.z));
      a *= smoothstep(0.0, 0.35, df) * smoothstep(0.0, 0.3, dw + 0.15);
    }
    gl_FragColor = vec4(t.rgb * vTint * light * a, t.a * a);
  }`;

class Emitter {
  constructor(o) { Object.assign(this, { rate: 0, acc: 0 }, o); }
}

export class Smoke {
  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.attrs = {
      iPos: new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3),
      iSize: new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1),
      iFrame: new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1),
      iAlpha: new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1),
      iRot: new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1),
      iTint: new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1),
    };
    for (const [k, a] of Object.entries(this.attrs)) { a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, a); }
    geo.instanceCount = 0;
    const map = new THREE.TextureLoader().load('assets/fx_smoke.png');
    // Raw sRGB, premultiplied on disk: blended as authored, the way the
    // visionOS app shows it (decoding to linear darkens every soft edge).
    map.colorSpace = THREE.NoColorSpace;
    map.premultiplyAlpha = false;
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        map: { value: map }, toRoom: { value: new THREE.Matrix4() }, softRoom: { value: 1 },
        roomHalf: { value: new THREE.Vector3(ROOM.w / 2, ROOM.h, ROOM.d / 2) }, light: { value: new THREE.Color(1, 1, 1) },
      },
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.root = new THREE.Group();
    this.root.name = 'smoke';
    this.root.add(this.mesh);

    this.p = [];   // live particles
    // Floor smoke rolling outward from under the feet.
    this.floor = new Emitter({ shape: 'ring', r: 0.5, y: 0.32, dir: 'out', speed: 0.9, speedVar: 0.4, life: 4.5, lifeVar: 1, size: 0.6, sizeVar: 0.2, grow: 2.6, rot: 0.3, spin: 0.12, damp: 0.9, accY: 0.06, curve: 'gradual', base: 34 });
    // Jet blasted down from under the feet, flattening out on the floor.
    this.jet = new Emitter({ shape: 'sphere', r: 0.15, y: 0.25, dir: 'down', spread: 0.5, speed: 2.2, speedVar: 0.6, life: 1.8, lifeVar: 0.4, size: 0.35, sizeVar: 0.08, grow: 4, rot: 0.3, spin: 0.12, damp: 1.6, accY: 0.15, curve: 'quick', base: 40 });
    // Shroud streaming down past the user after the crossing; born on a
    // shell around the head, never on it.
    this.shroud = new Emitter({ shape: 'shell', r: 4, rMin: 1.6, y: 1.6, dir: 'down', spread: 0.3, speed: 4.5, speedVar: 1.5, life: 1.5, lifeVar: 0.3, size: 1.3, sizeVar: 0.3, grow: 1.8, rot: 0.3, spin: 0.12, damp: 0.2, accY: 0, curve: 'gradual', base: 70 });
    this.emitters = [this.floor, this.jet, this.shroud];
    this.trail = false;
  }

  /** Levels 0…1: the smoke cloud, and the thrust jet from ignition on. */
  set(smoke, thrust) {
    const snap = (v) => (v < 0.03 ? 0 : v);
    this.floor.rate = this.floor.base * snap(smoke);
    this.jet.rate = this.jet.base * snap(thrust);
  }
  setShroud(level) { this.shroud.rate = this.shroud.base * (level < 0.03 ? 0 : level); }

  /** After the crossing the exhaust rides with the user. */
  trailMode() {
    this.trail = true;
    this.material.uniforms.softRoom.value = 0;
    Object.assign(this.floor, { shape: 'sphere', r: 0.5, y: -0.5, dir: 'down', spread: 0.55, speed: 4, speedVar: 1.4, life: 2.6, lifeVar: 0.5, size: 1.1, grow: 6, accY: 0, damp: 0.25, base: 70 });
    Object.assign(this.jet, { y: -0.1, speed: 3.5, spread: 0.3, damp: 0.3, accY: 0, base: 50 });
  }

  get count() { return this.p.length; }

  spawn(e) {
    if (this.p.length >= MAX) return;
    let x, y, z, vx, vy, vz;
    const rnd = (v) => (Math.random() * 2 - 1) * v;
    if (e.shape === 'ring') {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * e.r;
      x = Math.cos(a) * r; z = Math.sin(a) * r; y = e.y + rnd(0.025);
    } else {
      let d; do { d = [rnd(1), rnd(1), rnd(1)]; } while (d[0] ** 2 + d[1] ** 2 + d[2] ** 2 > 1);
      if (e.shape === 'shell') {
        const l = Math.hypot(...d) || 1, r = e.rMin + Math.random() * (e.r / 2 - e.rMin);
        d = d.map((v) => (v / l) * r);
      } else d = d.map((v) => v * e.r);
      x = d[0]; y = e.y + d[1]; z = d[2];
    }
    const speed = e.speed + rnd(e.speedVar);
    if (e.dir === 'out') {
      const l = Math.hypot(x, z) || 1; vx = (x / l) * speed; vz = (z / l) * speed; vy = rnd(0.05);
      if (Math.hypot(x, z) < 1e-3) { const a = Math.random() * Math.PI * 2; vx = Math.cos(a) * speed; vz = Math.sin(a) * speed; }
    } else {
      // Down, within a cone of `spread` radians.
      const t = Math.acos(1 - Math.random() * (1 - Math.cos(e.spread))), ph = Math.random() * Math.PI * 2;
      vx = Math.sin(t) * Math.cos(ph) * speed; vz = Math.sin(t) * Math.sin(ph) * speed; vy = -Math.cos(t) * speed;
    }
    const life = Math.max(0.2, e.life + rnd(e.lifeVar));
    this.p.push({
      x, y, z, vx, vy, vz, age: 0, life, e,
      size: Math.max(0.05, e.size + rnd(e.sizeVar)),
      rot: rnd(e.rot), spin: rnd(e.spin),
      frame0: Math.random() * 3, fps: (FRAMES / life) * (1 + rnd(0.15)),
      tint: 0.9 + Math.random() * 0.1,
    });
  }

  update(dt, camera, worldToRoom, light) {
    for (const e of this.emitters) {
      e.acc += e.rate * dt;
      while (e.acc >= 1) { e.acc -= 1; this.spawn(e); }
      if (e.rate === 0) e.acc = 0;
    }
    const keep = [];
    for (const q of this.p) {
      q.age += dt;
      if (q.age >= q.life) continue;
      const d = Math.exp(-q.e.damp * dt);
      q.vx *= d; q.vy = q.vy * d + q.e.accY * dt; q.vz *= d;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (!this.trail && q.y < 0.05) { q.y = 0.05; q.vy = Math.abs(q.vy) * 0.1; }   // spread along the floor
      q.rot += q.spin * dt;
      keep.push(q);
    }
    this.p = keep;

    // Back to front for correct blending.
    const cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    this.root.worldToLocal(cam);
    for (const q of this.p) q.dist = (q.x - cam.x) ** 2 + (q.y - cam.y) ** 2 + (q.z - cam.z) ** 2;
    this.p.sort((a, b) => b.dist - a.dist);

    const A = this.attrs;
    this.p.forEach((q, i) => {
      const t = q.age / q.life;
      const g = 1 + (q.e.grow - 1) * t;
      A.iPos.array.set([q.x, q.y, q.z], i * 3);
      A.iSize.array[i] = q.size * g;
      A.iFrame.array[i] = Math.min(FRAMES - 1, q.frame0 + q.age * q.fps);
      A.iAlpha.array[i] = q.e.curve === 'quick' ? Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.3) : Math.min(1, t / 0.2) * Math.min(1, (1 - t) / 0.45);
      A.iRot.array[i] = q.rot;
      A.iTint.array[i] = q.tint;
    });
    for (const a of Object.values(A)) a.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.p.length;
    this.material.uniforms.toRoom.value.copy(worldToRoom);
    if (light) this.material.uniforms.light.value.copy(light);
  }
}
