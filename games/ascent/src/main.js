// Ascent for the web: the visionOS app's flight in WebXR (immersive-vr), with
// a virtual loft in place of the real room.
//
// Sequence:
//   intro     – in the loft. "Look up." The portal opens once you look up
//               (or after a few seconds).
//   portal    – the ceiling irises open onto the sky. Smoke rolls over the
//               floor, then the jet starts. 8 s countdown.
//   liftoff   – the world starts descending; the hole grows to meet you.
//   ascending – through the ceiling, the city, the atmosphere, to orbit.
//   arrived   – parked at geostationary altitude, looking at Earth.
//
// URL switches for testing: ?city=baku&autostart=1&portalT=6&stop=40&jump=4e7&look=60,0&speed=2

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LocalFrame } from './geo.js';
import { Flight, HEAD_HEIGHT } from './flight.js';
import { TileLayer, prefetchTiles } from './tiles.js';
import { Sky } from './sky.js';
import { Earth } from './earth.js';
import { Room, ROOM } from './room.js';
import { Smoke } from './smoke.js';
import { fetchBuildings, buildBuildings, facadeTexture, HIDE_ABOVE } from './buildings.js';
import { fetchLandmarks, fetchCities, fetchSummary } from './places.js';
import { Markers } from './markers.js';
import { HUD, PlaceCard } from './hud.js';
import { Cockpit } from './cockpit.js';

const PRESETS = [
  { id: 'baku', name: 'Baku', country: 'Azerbaijan', lat: 40.3667, lon: 49.8352 },
  { id: 'moscow', name: 'Moscow', country: 'Russia', lat: 55.7539, lon: 37.6208 },
  { id: 'newyork', name: 'New York', country: 'United States', lat: 40.758, lon: -73.9855 },
  { id: 'london', name: 'London', country: 'United Kingdom', lat: 51.5007, lon: -0.1246 },
  { id: 'paris', name: 'Paris', country: 'France', lat: 48.8584, lon: 2.2945 },
  { id: 'dubai', name: 'Dubai', country: 'UAE', lat: 25.1972, lon: 55.2744 },
  { id: 'istanbul', name: 'Istanbul', country: 'Türkiye', lat: 41.0086, lon: 28.9802 },
  { id: 'tokyo', name: 'Tokyo', country: 'Japan', lat: 35.6595, lon: 139.7005 },
  { id: 'sanfrancisco', name: 'San Francisco', country: 'United States', lat: 37.8024, lon: -122.4058 },
  { id: 'rio', name: 'Rio de Janeiro', country: 'Brazil', lat: -22.9711, lon: -43.1822 },
];

const params = new URLSearchParams(location.search);
const num = (k) => (params.has(k) ? parseFloat(params.get(k)) : null);
const DEBUG = { autostart: params.get('autostart') === '1', portalT: num('portalT'), stop: num('stop'), jump: num('jump'), speed: num('speed'), noHud: params.get('hud') === '0',
  look: params.has('look') ? params.get('look').split(',').map(Number) : null };

const smooth = (x) => x * x * (3 - 2 * x);
const CONTROLS = new Set(['up', 'down', 'fwd', 'back', 'left', 'right', 'rotl', 'rotr']);
/** The loft is on top of a tower: its floor is this far above the ground. At
 *  street level the satellite imagery outside the glass would be a blurry
 *  flat photo; from here it reads as a city. */
const TOWER = 45;
const PORTAL_DURATION = 8, PORTAL_GROWTH = 2.6;
const EXHAUST_FADE_START = 150, EXHAUST_FADE_END = 200;

// ---------------------------------------------------------------------------
// Renderer

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = false;   // closed room, no sun: nothing needs shadows
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.4);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 120000);
camera.position.set(0, HEAD_HEIGHT, 0);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// ---------------------------------------------------------------------------
// Flight scene

class Ascent {
  constructor(place, speed) {
    this.place = place;
    this.speed = speed;
    this.frame = new LocalFrame(place.lat, place.lon);
    this.scene = new THREE.Scene();
    this.scene.environment = environment();      // soft reflections on the floor and frames
    this.scene.environmentIntensity = 0.45;
    this.world = new THREE.Group(); this.world.name = 'world';
    this.sky = new Sky(this.frame);
    this.tiles = new TileLayer(this.frame, renderer);
    this.room = new Room();
    this.smoke = new Smoke();
    this.earth = new Earth(this.frame);
    this.markers = new Markers(this.frame);
    this.hud = new HUD();
    this.card = new PlaceCard();
    this.card.group.visible = false;
    // Ground-anchored content sits TOWER below the loft's floor.
    this.ground = new THREE.Group(); this.ground.name = 'ground';
    this.ground.position.y = -TOWER;
    this.ground.add(this.tiles.root);
    this.world.add(this.ground, this.room.root, this.smoke.root, buildTower(TOWER));
    this.scene.add(this.sky.root, this.world, this.earth.mesh, this.markers.root, this.card.group, this.hud.status.group);
    this.cockpit = new Cockpit(this.hud.controls, this.hud.gauge, environment());
    this.scene.add(this.cockpit.root);

    this.flight = new Flight();
    this.phase = 'intro';
    this.phaseTime = 0;
    this.crossed = false;
    this.paused = false;
    this.lookUpTime = 0;
    this.exhaustGone = 0;
    this.hudPlaced = false;
    // Where we are over the planet: the ground point under the user, and a
    // turn about the vertical. Start: right above the loft.
    this.nav = { lat: place.lat, lon: place.lon, yaw: 0 };
    this.maxAscent = 0;
    this.hold = null;     // control button being held

    fetchBuildings(place.lat, place.lon).then((list) => {
      this.buildings = buildBuildings(list, this.frame);
      this.ground.add(this.buildings);
      setStatus(`${list.length} buildings`);
    }).catch((e) => console.warn('buildings', e));
    fetchLandmarks(place.lat, place.lon).then((l) => this.markers.add(l)).catch((e) => console.warn('landmarks', e));
    // Seen from geography (tiles, Earth, labels) the eye is TOWER higher.
    const flight = () => this.flight;
    this.geo = {
      get ascent() { return flight().ascent + TOWER; },
      get altitude() { return flight().altitude + TOWER; },
      altitudeAfter: (s, v) => flight().altitudeAfter(s, v) + TOWER,
    };
    fetchCities().then((l) => this.markers.add(l)).catch((e) => console.warn('cities', e));

    if (DEBUG.jump) {
      this.flight.jump(DEBUG.jump);
      this.cross();
      this.smoke.set(0, 0); this.smoke.setShroud(0);
    }
    this.updateTiles();
  }

  /** Head pose in scene space (XR camera, or the preview camera). */
  head() {
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    const m = cam.matrixWorld;
    const eye = new THREE.Vector3().setFromMatrixPosition(m);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    return { eye, fwd, up, quat };
  }

  tick(dt) {
    this.phaseTime += dt;
    this.frames = (this.frames || 0) + 1;
    const { eye, fwd } = this.head();
    switch (this.phase) {
      case 'intro': {
        // Open once the user has looked up for a moment, or after a while.
        if (fwd.y > 0.45) this.lookUpTime += dt; else this.lookUpTime = Math.max(0, this.lookUpTime - dt);
        if ((this.phaseTime > 2.5 && this.lookUpTime > 0.6) || this.phaseTime > 9 || DEBUG.autostart) {
          this.phase = 'portal'; this.phaseTime = 0; this.room.burstDust();
        }
        this.room.update(dt, 0);
        break;
      }
      case 'portal': {
        if (DEBUG.portalT != null) this.phaseTime = Math.min(this.phaseTime, DEBUG.portalT);
        const t = this.phaseTime;
        this.room.setOpen(smooth(Math.min(1, t / 1.5)));
        this.room.update(dt, 1);
        this.smoke.set(Math.min(1, Math.max(0, (t - 1) / 4)), Math.min(1, Math.max(0, (t - 5) / 2.5)));
        this.countdown = Math.max(0, Math.ceil(PORTAL_DURATION - t));
        if (t >= PORTAL_DURATION) { this.phase = 'liftoff'; this.phaseTime = 0; }
        break;
      }
      case 'liftoff': {
        if (!this.paused && !this.debugStopped) this.flight.advance(dt, this.speed);
        this.room.setGrowth(1 + (PORTAL_GROWTH - 1) * smooth(Math.min(1, this.phaseTime / 3)));
        this.room.update(dt, 1);
        this.applyFlight(eye);
        const ceilingY = this.room.portal.getWorldPosition(new THREE.Vector3()).y;
        if (ceilingY < eye.y + 0.3) this.cross();
        break;
      }
      case 'ascending':
      case 'arrived': {
        if (!this.paused && !this.debugStopped && !this.hold && !this.dragging) this.flight.advance(dt, this.speed);
        this.fly(dt);
        this.applyFlight(eye);
        this.room.update(dt, 0);
        // Emission winds down 150–200 m; the last puffs drift away below.
        // (By the highest point reached: descending again brings no smoke back.)
        this.maxAscent = Math.max(this.maxAscent, this.flight.ascent);
        const a = this.maxAscent;
        const fade = 1 - smooth(Math.min(1, Math.max(0, (a - EXHAUST_FADE_START) / (EXHAUST_FADE_END - EXHAUST_FADE_START))));
        if (this.smoke.root.visible) {
          this.smoke.set(fade, fade); this.smoke.setShroud(fade);
          this.exhaustGone = a > EXHAUST_FADE_END ? this.exhaustGone + dt : 0;
          if (this.exhaustGone > 3.5) this.smoke.root.visible = false;
        }
        if (this.flight.isComplete && this.phase === 'ascending') this.phase = 'arrived';
        if (!this.flight.isComplete && this.phase === 'arrived') this.phase = 'ascending';
        this.markers.update(this.view, eye, this.head().quat);
        break;
      }
    }
    if (this.smoke.root.visible) {
      const toRoom = this.room.root.matrixWorld.clone().invert();
      this.smoke.update(dt, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, toRoom);
    }
    this.sky.root.position.copy(eye);
    this.updateHUD(dt);
  }

  /** Held control buttons: climb/descend, move over the ground, turn. */
  fly(dt) {
    const h = this.hold;
    if (!h) return;
    if (h === 'up') this.flight.advance(dt, 2.2 * this.speed);
    else if (h === 'down') this.flight.advance(dt, -1.8 * this.speed);
    else if (h === 'rotl' || h === 'rotr') this.nav.yaw += (h === 'rotl' ? -1 : 1) * 0.7 * dt;   // ↺ turns you left: the world turns right
    else {
      // Along the ground, the way the console faces (the ship's nose); faster higher up.
      const f = (this.cockpit.forward || new THREE.Vector3(0, 0, -1)).clone();
      const dir = { fwd: f, back: f.clone().negate(), left: new THREE.Vector3(f.z, 0, -f.x), right: new THREE.Vector3(-f.z, 0, f.x) }[h];
      // Scene direction → east/south at the ground point (undo pitch and yaw).
      const d = dir.clone().applyQuaternion(this.qTurn.clone().invert());
      this.moveGround(d.x, d.z, Math.max(20, 0.45 * this.geo.altitude) * this.speed * dt);
    }
  }

  get debugStopped() {
    const stop = DEBUG.stop ?? DEBUG.jump;
    return stop != null && this.flight.ascent >= stop * 0.999;
  }

  /** The portal reached the eyes: the exhaust rides with the user from here. */
  cross() {
    if (this.crossed) return;
    this.crossed = true;
    this.scene.attach(this.smoke.root);
    this.smoke.root.position.set(0, 0, 0); this.smoke.root.quaternion.identity(); this.smoke.root.scale.setScalar(1);
    this.smoke.trailMode();
    this.flight.minAscent = 60;     // manual descent stops above the rooftops
    this.phase = 'ascending'; this.phaseTime = 0;
    this.applyFlight(this.head().eye);
  }

  /** Places the world for the current altitude, ground point and turn.
   *  Anchor-frame point X (ground content is TOWER lower in the world):
   *    scene = Q · k · (X − P),  Q = pitch · yaw · M,
   *  where M turns the ground point's east/up/south onto x/y/z and P is the
   *  anchor-frame point that lands at the scene origin (under the eyes). */
  applyFlight(eye) {
    const f = this.flight, k = f.scale, g = this.geo;
    const b = this.frame.basisAt(this.nav.lat, this.nav.lon);
    const M = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...b.east), new THREE.Vector3(...b.up), new THREE.Vector3(...b.south))).invert();
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), f.pitch);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.nav.yaw);
    this.qTurn = qPitch.clone().multiply(qYaw);
    const Q = this.qTurn.clone().multiply(M);
    const ground = this.frame.position(this.nav.lat, this.nav.lon);
    // P in world coordinates (ground content sits TOWER below world zero).
    const P = new THREE.Vector3(...ground).addScaledVector(new THREE.Vector3(...b.up), g.ascent);
    P.y -= TOWER;
    this.world.scale.setScalar(k);
    this.world.quaternion.copy(Q);
    this.world.position.copy(P).multiplyScalar(-k).applyQuaternion(Q);
    this.sky.root.quaternion.copy(Q);
    this.sky.update(g.altitude);
    // The eye in the anchor frame, for the Earth and the labels.
    const qInv = Q.clone().invert();
    const eyeLocal = eye.clone().applyQuaternion(qInv).divideScalar(k).add(P); eyeLocal.y += TOWER;
    this.view = {
      ascent: g.ascent, eyeLocal, qInv,
      toScene: (X) => X.clone().sub(new THREE.Vector3(0, TOWER, 0)).sub(P).multiplyScalar(k).applyQuaternion(Q),
    };
    this.groundLocal = ground;
    this.earth.update(this.view, eye);
    this.tiles.root.visible = !this.earth.planetOpaque(g.ascent);
    if (this.buildings) this.buildings.visible = g.altitude < HIDE_ABOVE;
    this.updateTiles();
  }

  updateTiles() {
    const s = this.paused ? 0 : this.speed;
    const centre = { lat: this.nav.lat, lon: this.nav.lon, local: this.groundLocal || [0, 0, 0] };
    this.tiles.update([this.geo.altitude, this.geo.altitudeAfter(3, s), this.geo.altitudeAfter(6, s)], centre);
  }

  /** About a metre out, a little below the line of sight, trailing the gaze;
   *  follows the heading and part of the pitch, always upright. */
  updateHUD(dt) {
    const { eye, fwd, up } = this.head();
    const s = { phase: this.phase, countdown: this.countdown || 0, altitude: this.geo.altitude, paused: this.paused, homeName: this.place.label,
      // Teach the drag until it has been used once (XR only).
      dragHint: renderer.xr.isPresenting && !this.usedDrag };
    this.hud.draw(s);
    if (!this.cockpit.placed && this.frames > 4) this.cockpit.place(eye, fwd);
    const heading = fwd.clone().addScaledVector(up, -fwd.y); heading.y = 0;
    if (heading.lengthSq() > 1e-6) {
      heading.normalize();
      const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
      // status: below the gaze, trailing the heading.
      {
        const el = Math.max(-0.1, Math.min(0.35, pitch - 0.33));   // never down on the console
        const target = eye.clone().addScaledVector(heading, Math.cos(el) * 1.05); target.y += Math.sin(el) * 1.05;
        const g = this.hud.status.group;
        if (!this.hud.status.placed) { g.position.copy(target); this.hud.status.placed = true; }
        else g.position.lerp(target, 1 - Math.exp(-dt * 2.2));
        faceUpright(g, eye);
      }
    }
    const hide = DEBUG.noHud || !!this.card.place;
    if (hide) for (const p of this.hud.panels) p.group.visible = false;
    if (this.card.place) { this.card.draw(); faceUpright(this.card.group, eye); }
  }

  openCard(place) {
    this.pausedBefore = this.card.place ? this.pausedBefore : this.paused;
    this.paused = true;
    this.card.show(place, fetchSummary(place));
    const { eye, fwd } = this.head();
    const f = fwd.clone(); f.y = Math.max(-0.5, Math.min(0.3, f.y)); f.normalize();
    this.card.group.position.copy(eye).addScaledVector(f, 1.1); this.card.group.position.y -= 0.1;
    this.card.group.visible = true;
  }
  closeCard() { this.card.place = null; this.card.group.visible = false; this.paused = this.pausedBefore; }

  /** A pinch/click ray: press feedback now, action on release. Returns
   *  false when nothing was hit (a drag can start). */
  press(ray) {
    this.pressTarget = null;
    if (this.card.place) {
      // Pinch the Close button, or anywhere off the card, to close it.
      const id = this.card.panel.hitTest(ray);
      if (id !== 'panel') { this.card.panel.pressed = id || null; this.pressTarget = { kind: 'card', id: id || 'close' }; }
      return true;
    }
    for (const panel of this.hud.panels) {
      const id = panel.hitTest(ray);
      if (!id) continue;
      if (id !== 'panel') {
        panel.pressed = id;
        this.pressTarget = { kind: 'hud', id };
        if (CONTROLS.has(id)) this.hold = id;     // acts while held
      }
      return true;
    }
    const place = this.markers.pick(ray);
    if (place) { this.markers.setPressed(place); this.pressTarget = { kind: 'place', place }; return true; }
    return false;
  }

  /** Pinch-and-drag flying: `d` is the hand's movement this frame (scene, metres). */
  dragBy(d) {
    if (!this.crossed || !this.qTurn) return;
    this.dragging = true;
    this.usedDrag = true;
    // Up/down: 10 cm of hand ≈ ×1.4 altitude.
    if (Math.abs(d.y) > 1e-5) {
      const f = this.flight;
      f.u = Math.max(Math.log(f.minAscent + 1), f.u + d.y * 3.2);
    }
    // Over the ground: 10 cm of hand ≈ the current altitude.
    const horiz = new THREE.Vector3(d.x, 0, d.z).applyQuaternion(this.qTurn.clone().invert());
    this.moveGround(horiz.x, horiz.z, 10 * this.geo.altitude);
  }
  endDrag() { this.dragging = false; }

  /** Moves the ground point by (east, south) × `scale` metres. */
  moveGround(east, south, scale) {
    const R = 6_371_000, lat = this.nav.lat * Math.PI / 180;
    this.nav.lat = Math.max(-84, Math.min(84, this.nav.lat - (south * scale / R) * 180 / Math.PI));
    this.nav.lon = ((this.nav.lon + (east * scale / (R * Math.cos(lat))) * 180 / Math.PI + 540) % 360) - 180;
  }
  release() {
    const t = this.pressTarget; this.pressTarget = null;
    this.hold = null;
    for (const p of this.hud.panels) p.pressed = null;
    this.card.panel.pressed = null; this.markers.setPressed(null);
    if (!t) return;
    if (t.kind === 'place') this.openCard(t.place);
    else if (t.kind === 'card' && t.id === 'close') this.closeCard();
    else if (t.kind === 'hud') {
      if (t.id === 'pause') this.paused = !this.paused;
      else if (t.id === 'confirm') this.hud.confirming = true;
      else if (t.id === 'keep') this.hud.confirming = false;
      else if (t.id === 'end' || t.id === 'home') endFlight();
      else if (t.id === 'again') flyAgain();
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { for (const v of Object.values(m)) if (v?.isTexture && v !== envTex) v.dispose(); if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value?.isTexture) u.value.dispose(); m.dispose(); }
    });
  }
}

/** The tower under the loft, with the same curtain-wall facade as the city. */
function buildTower(h) {
  const { w, d } = ROOM;
  const geo = new THREE.BoxGeometry(w + 0.4, h, d + 0.4);
  const uv = geo.attributes.uv;
  // Facade texture: 8 bays × 4 floors per repeat (3 m bays, 3.4 m floors).
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4), along = face < 2 ? d + 0.4 : w + 0.4;
    uv.setXY(i, uv.getX(i) * along / 24, uv.getY(i) * h / 13.6);
  }
  const mat = new THREE.MeshStandardMaterial({ map: facadeTexture(), roughness: 0.5, metalness: 0.1 });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = -h / 2 - 0.01;
  m.name = 'tower';
  return m;
}

/** Pins `mesh` to the head: its world matrix is set right before it is drawn,
 *  from the head pose of that very frame (the XR camera is only updated inside
 *  render), so it never lags or swims. `az`/`el` (radians) place it in the
 *  view, `dist` metres out, turned to face the eye. Hit tests use the same
 *  matrix, which stays as last drawn. */
function headLock(mesh, az, el, dist) {
  const pos = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(dist);
  const offset = new THREE.Matrix4().lookAt(new THREE.Vector3(), pos, new THREE.Vector3(0, 1, 0)).setPosition(pos);
  mesh.frustumCulled = false;
  mesh.onBeforeRender = (r) => {
    const head = r.xr.isPresenting ? r.xr.getCamera() : camera;
    mesh.updateMatrix();
    mesh.matrixWorld.multiplyMatrices(head.matrixWorld, offset).multiply(mesh.matrix);
  };
}

let envTex = null;
function environment() {
  if (!envTex) {
    const pm = new THREE.PMREMGenerator(renderer);
    envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  return envTex;
}

function faceUpright(obj, eye) {
  const z = eye.clone().sub(obj.position); z.y = z.y; z.normalize();
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z);
  if (x.lengthSq() < 1e-8) return;
  x.normalize();
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x), z));
}

// ---------------------------------------------------------------------------
// Input: XR select (gaze + pinch on Vision Pro, or controllers) and mouse.

// The controller objects are not in the scene, so their matrixWorld is never
// updated: read the pose from `matrix`, which three sets from the XR frame
// (reference space = world here; the camera has no parent).
//
// Pinch on a button or label presses it. Pinch on empty space and drag to fly:
// move your hand the way you want to go (left/right/forward/back over the
// ground, up/down to climb or descend). On Vision Pro the pinch is a
// transient pointer; the hand's grip pose is used when available, else a
// point a metre along the ray, which follows the hand too.
const hands = [0, 1].map((i) => ({ ray: renderer.xr.getController(i), grip: renderer.xr.getControllerGrip(i), drag: null }));
function handPoint(h) {
  if (h.hasGrip && h.grip.visible) return new THREE.Vector3().setFromMatrixPosition(h.grip.matrix);
  const o = new THREE.Vector3().setFromMatrixPosition(h.ray.matrix);
  return o.addScaledVector(new THREE.Vector3(0, 0, -1).transformDirection(h.ray.matrix), 1.0);
}
for (const h of hands) {
  h.grip.addEventListener('connected', (e) => { h.hasGrip = !!e.data?.gripSpace; });
  h.grip.addEventListener('disconnected', () => { h.hasGrip = false; });
  h.ray.addEventListener('selectstart', () => {
    if (!app) return;
    const o = new THREE.Vector3().setFromMatrixPosition(h.ray.matrix);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(h.ray.matrix);
    if (!app.press(new THREE.Ray(o, d))) h.drag = { last: handPoint(h) };
  });
  h.ray.addEventListener('selectend', () => {
    if (h.drag) { h.drag = null; app?.endDrag(); } else app?.release();
  });
}
function updateHands() {
  for (const h of hands) {
    if (!h.drag || !app) continue;
    const p = handPoint(h);
    app.dragBy(p.clone().sub(h.drag.last));
    h.drag.last = p;
  }
}

// Preview mode: drag to look around, click to press.
let drag = null, yaw = 0, pitch = 0;
if (DEBUG.look) { pitch = (DEBUG.look[0] * Math.PI) / 180; yaw = ((DEBUG.look[1] || 0) * Math.PI) / 180; }
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; canvas.setPointerCapture(e.pointerId);
  if (app) { const r = mouseRay(e); app.press(r); } });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  yaw += dx * 0.004; pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.004));
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', () => { if (drag && !drag.moved) app?.release(); else if (app) { app.pressTarget = null; app.release(); } drag = null; });
function mouseRay(e) {
  const v = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(v, camera);
  return rc.ray;
}

// ---------------------------------------------------------------------------
// App flow

let app = null;
let session = null;
const ui = {
  launch: document.getElementById('launch'), enter: document.getElementById('enter'),
  modeVR: document.getElementById('modeVR'), modeFlat: document.getElementById('modeFlat'),
  start: document.getElementById('start'), places: document.getElementById('places'), where: document.getElementById('where'), speed: document.getElementById('speed'), speedOut: document.getElementById('speedOut'), status: document.getElementById('status'),
};
function setStatus(s) { ui.status.textContent = s; }

// The hidden <select> holds the choice; the tiles show it.
ui.start.innerHTML = `<option value="here">My location</option>` + PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
try { ui.start.value = localStorage.getItem('startID') || 'baku'; } catch { ui.start.value = 'baku'; }
if (params.has('city')) ui.start.value = params.get('city');
const PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z" fill="currentColor"/></svg>';
ui.places.innerHTML = `<button class="place here" role="radio" data-id="here"><span class="pin">${PIN}</span><span><span class="n">My location</span><br><span class="c">Start right where you are</span></span></button>`
  + PRESETS.map((p) => `<button class="place" role="radio" data-id="${p.id}"><span class="n">${p.name}</span><span class="c">${p.country}</span></button>`).join('');
const hereTile = ui.places.querySelector('.here');
ui.places.addEventListener('click', (e) => {
  const b = e.target.closest('.place');
  if (!b || b.disabled) return;
  choose(b.dataset.id);
});
function choose(id) {
  ui.start.value = id;
  try { localStorage.setItem('startID', id); } catch {}
  for (const b of ui.places.children) b.setAttribute('aria-checked', String(b.dataset.id === id));
  if (id !== 'here') showWhere('');
  updateEnterLabel(); prefetch();
}

// Start downloading the chosen city while the user reads the launch page.
let cancelPrefetch = null;
function prefetch() {
  cancelPrefetch?.();
  if (ui.start.value === 'here') { locate().then((p) => { if (p && ui.start.value === 'here') prefetchPlace(p); }); return; }
  prefetchPlace(PRESETS.find((x) => x.id === ui.start.value));
}
function prefetchPlace(p) {
  if (!p) return;
  cancelPrefetch = prefetchTiles(new LocalFrame(p.lat, p.lon), (n, total) => setStatus(`${p.name}: imagery ${n}/${total}`));
  fetchBuildings(p.lat, p.lon).catch(() => {});
  fetchLandmarks(p.lat, p.lon).catch(() => {});
}
fetchCities().catch(() => {});
ui.speed.addEventListener('input', () => { ui.speedOut.textContent = `${parseFloat(ui.speed.value).toFixed(1)}×`; });
if (DEBUG.speed) ui.speed.value = DEBUG.speed;

// One Launch button; the toggle picks immersive VR or a flat window (drag to
// look, click to press). Immersive is the default wherever VR is available.
let xrSupported = false, xrChecked = false, immersive = true;
function setMode(vr) {
  immersive = vr;
  ui.modeVR.setAttribute('aria-checked', String(vr));
  ui.modeFlat.setAttribute('aria-checked', String(!vr));
  updateEnterLabel();
}
ui.modeVR.addEventListener('click', () => { if (xrSupported) setMode(true); });
ui.modeFlat.addEventListener('click', () => setMode(false));
function updateEnterLabel() {
  const name = ui.start.value === 'here' ? 'your location' : PRESETS.find((p) => p.id === ui.start.value)?.name;
  ui.modeVR.disabled = xrChecked && !xrSupported;
  if (immersive && !xrChecked) { ui.enter.textContent = 'Checking for VR…'; ui.enter.disabled = true; return; }
  ui.enter.textContent = `Launch from ${name}`;
  ui.enter.disabled = false;
}
// Say why VR is unavailable: the usual causes are an insecure context (an
// untrusted certificate) or WebXR switched off in Safari's feature flags.
const xrDiag = document.getElementById('xrdiag');
function diag(msg) { xrDiag.textContent = msg; xrDiag.hidden = !msg; }
if (!window.isSecureContext) diag('VR needs a secure (https) page with a trusted certificate. This page is not a secure context.');
else if (!navigator.xr) diag('This browser has no WebXR. On Vision Pro: Settings → Apps → Safari → Advanced → Feature Flags → turn on "WebXR Device API", then reload.');
(navigator.xr ? navigator.xr.isSessionSupported('immersive-vr') : Promise.resolve(false)).then((ok) => {
  xrSupported = ok; xrChecked = true;
  setMode(ok);
  if (navigator.xr && !ok) diag('WebXR is present but immersive VR is not supported here. On Vision Pro, check Safari feature flags for "WebXR Device API".');
}, (e) => { xrChecked = true; setMode(false); diag('WebXR check failed: ' + e.message); });

// "My location" is found on the launch page, before VR starts: inside an
// immersive session Safari's permission prompt can't be seen, so the request
// would just time out. When the site isn't allowed to use location, the tile
// says so and can't be picked until it is (the permission state is watched).
let located = null, here = null, locationBlocked = false;
function locate() {
  if (locationBlocked) return Promise.resolve(null);
  if (located) return located;
  showWhere('Finding your location…');
  located = new Promise((res) => navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      here = { id: 'here', name: 'your location', lat, lon };
      setHereTile(`${lat.toFixed(3)}, ${lon.toFixed(3)} · within ${Math.round(accuracy)} m`);
      showWhere('');
      res(here);
    },
    (e) => {
      located = null;
      if (e.code === 1) blockLocation(true);
      else showWhere("Couldn't find your location. Try again, or pick a city.", true);
      res(null);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }));
  return located;
}
function setHereTile(sub) { hereTile.querySelector('.c').textContent = sub; }
function blockLocation(blocked) {
  locationBlocked = blocked;
  hereTile.disabled = blocked;
  hereTile.querySelector('.pin').innerHTML = blocked ? LOCK : PIN;
  if (blocked) {
    here = null; located = null;
    setHereTile('Not allowed: turn on Location for Safari in Settings › Privacy & Security › Location Services › Safari Websites.');
    if (ui.start.value === 'here') choose(PRESETS[0].id);
  } else setHereTile('Start right where you are');
}
if (!navigator.geolocation) { blockLocation(true); setHereTile('This browser has no location.'); }
navigator.permissions?.query({ name: 'geolocation' }).then((st) => {
  const sync = () => {
    const was = locationBlocked;
    blockLocation(st.state === 'denied');
    if (was && !locationBlocked) setHereTile('Allowed now: tap to start from here');
  };
  sync();
  st.addEventListener('change', sync);
}).catch(() => {});
function showWhere(text, warn = false) { ui.where.textContent = text; ui.where.hidden = !text; ui.where.classList.toggle('warn', warn); }

async function resolveStart() {
  if (ui.start.value !== 'here') return PRESETS.find((p) => p.id === ui.start.value);
  return (await locate()) || PRESETS[0];
}

function begin(place) {
  cancelPrefetch?.();
  app?.dispose();
  app = new Ascent({ ...place, label: place.id === 'here' ? null : place.name }, parseFloat(ui.speed.value));
  ui.launch.classList.add('hidden');
}

ui.enter.addEventListener('click', async () => {
  // Never fall back to another city without saying so.
  if (ui.start.value === 'here' && !here) { locate(); return; }   // the tile says why
  if (!immersive) {
    begin(await resolveStart());
    document.documentElement.requestFullscreen?.().catch(() => {});
    return;
  }
  // Request the session first, inside the click, as Safari requires.
  let s;
  try { s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] }); }
  catch (e) { diag('Could not start VR: ' + e.message); return; }
  session = s;
  s.addEventListener('end', () => { session = null; returnToLaunch(); });
  await renderer.xr.setSession(s);
  // Recentring (hold the Digital Crown) stands the console in front again.
  renderer.xr.getReferenceSpace()?.addEventListener('reset', () => { if (app) app.cockpit.placed = false; });
  begin(await resolveStart());
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && app && !session) returnToLaunch(); });

function returnToLaunch() {
  app?.dispose(); app = null;
  ui.launch.classList.remove('hidden');
}
function endFlight() {
  if (session) session.end(); else returnToLaunch();
}
function flyAgain() {
  const p = app.place;
  begin(p);
}

choose(ui.start.value);
if (DEBUG.autostart) resolveStart().then(begin);

// ---------------------------------------------------------------------------
// Loop

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  // Headless test runs render a few frames a second: let them keep real time.
  const dt = Math.min(DEBUG.autostart ? 0.5 : 0.1, clock.getDelta());
  if (!renderer.xr.isPresenting) {
    camera.position.set(0, HEAD_HEIGHT, 0);
    camera.rotation.set(pitch, -yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }
  if (app) {
    updateHands();
    app.tick(dt);
    renderer.render(app.scene, camera);
  } else {
    renderer.clear();
  }
});

window.__ascent = () => app;
window.__renderer = renderer;
