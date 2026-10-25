// The flight deck: a console that stays put in front of the user, like the
// controls of a spacecraft: a small slanted desk with the control cluster at
// the front right, the altitude screen at the front left. It lives in the user's own space
// (not the moving world), placed once from where they stand and face, and
// again when they recentre.

import * as THREE from 'three';

const TILT = THREE.MathUtils.degToRad(36);   // desk surface, up from level
const DESK = { w: 0.42, d: 0.31, t: 0.03 };

export class Cockpit {
  /** `controls`, `gauge`: HUD panels to mount. */
  constructor(controls, gauge, envMap) {
    this.root = new THREE.Group(); this.root.name = 'cockpit';
    this.placed = false;
    const shell = new THREE.MeshStandardMaterial({ color: 0x23272f, metalness: 0.55, roughness: 0.42, envMap, envMapIntensity: 0.9 });
    const face = new THREE.MeshStandardMaterial({ color: 0x0b0d12, metalness: 0.2, roughness: 0.7, envMap, envMapIntensity: 0.5 });
    const trim = new THREE.MeshBasicMaterial({ color: 0x7fd2ff, transparent: true, opacity: 0.85 });

    // Desk: its top is the local x/z plane, front edge toward the user (+z).
    this.desk = new THREE.Group();
    const slab = new THREE.Mesh(roundedSlab(DESK.w, DESK.d, DESK.t, 0.03), shell);
    slab.position.y = -DESK.t / 2;
    const inset = new THREE.Mesh(new THREE.PlaneGeometry(DESK.w - 0.04, DESK.d - 0.04), face);
    inset.rotation.x = -Math.PI / 2; inset.position.y = 0.0015;
    const lip = new THREE.Mesh(new THREE.BoxGeometry(DESK.w - 0.06, 0.004, 0.004), trim);
    lip.position.set(0, -0.006, DESK.d / 2 + 0.001);
    // Underside: a tapered body so the desk reads as solid, not a floating plank.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.07, 0.12, 4, 1, false, Math.PI / 4), shell);
    body.scale.set(1.2, 1, 0.8);
    body.rotation.x = 0; body.position.set(0, -DESK.t - 0.06, -0.02);
    this.desk.add(slab, inset, lip, body);
    // Control cluster flat on the desk.
    const c = controls.group;
    c.rotation.x = -Math.PI / 2;
    c.position.set(0, 0.004, 0);
    // The cluster is drawn in the left 516 of 648 px: centre what is drawn.
    controls.mesh.position.x = 0.037;
    this.desk.add(c);
    this.controls = controls;

    // Altitude screen: at the left, tipped back, turned toward the user.
    this.screen = new THREE.Group();
    const bezel = new THREE.Mesh(roundedSlab(0.3, 0.47, 0.025, 0.025), shell);
    bezel.rotation.x = Math.PI / 2;           // slab's thin axis → z
    bezel.position.z = -0.014;
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.4, 0.004), trim);
    glow.position.set(0.152, 0, -0.004);
    this.screen.add(bezel, glow);
    gauge.group.position.set(0, 0, 0.001);
    this.screen.add(gauge.group);
    this.gauge = gauge;
    this.root.add(this.desk, this.screen);
  }

  /** Stands the console in front of the eye, along the facing `heading`. */
  place(eye, heading) {
    const h = new THREE.Vector3(heading.x, 0, heading.z);
    if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
    h.normalize();
    this.root.position.set(eye.x, 0, eye.z);
    this.root.rotation.set(0, Math.atan2(-h.x, -h.z), 0);
    // Both off to the sides so the view ahead and straight down stays open.
    // Desk: front right, ~0.5 m below the eye and in reach.
    const top = THREE.MathUtils.clamp(eye.y - 0.5, 0.55, 1.3);
    this.desk.position.set(0.3, top, -0.42);
    this.desk.rotation.set(TILT, -0.5, 0, 'YXZ');
    // Altitude screen: front left, centre a little below eye level.
    this.screen.position.set(-0.46, top + 0.3, -0.5);
    this.screen.rotation.set(-0.12, 0.6, 0, 'YXZ');
    this.forward = h.clone();
    this.placed = true;
  }

}

/** A box w × t × d with rounded corners in plan (x/z). */
function roundedSlab(w, d, t, r) {
  const s = new THREE.Shape();
  const x = w / 2, z = d / 2;
  s.moveTo(-x + r, -z); s.lineTo(x - r, -z); s.quadraticCurveTo(x, -z, x, -z + r);
  s.lineTo(x, z - r); s.quadraticCurveTo(x, z, x - r, z); s.lineTo(-x + r, z);
  s.quadraticCurveTo(-x, z, -x, z - r); s.lineTo(-x, -z + r); s.quadraticCurveTo(-x, -z, -x + r, -z);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 6 });
  g.rotateX(Math.PI / 2);          // extrude along −y; shape plane → x/z
  g.translate(0, t / 2, 0);
  return g;
}
