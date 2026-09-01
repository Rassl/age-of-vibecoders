/**
 * Escort drones and their bolts.
 *
 * The drone has to read as MACHINE against a road full of bodies, at a camera
 * that shows it maybe 40px tall. Three things carry that: hard flat panels with
 * no organic silhouette, rotor discs spinning fast enough to blur into rings,
 * and a status light that pulses. Everything else is too small to see.
 *
 * The bolt is drawn as a stretched core plus an additive halo, oriented ALONG
 * its own velocity -- a round bead gives the eye nothing to read direction from,
 * and the whole point of a drone shot is that it flies somewhere the squad is
 * not aiming.
 *
 * Read-only over sim state.
 */
import {
  AdditiveBlending, BoxGeometry, CircleGeometry, Color, CylinderGeometry, Group,
  IcosahedronGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D,
  Quaternion, SRGBColorSpace, Vector3,
} from 'three'
import { CFG } from '../config.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Lifted well off the road's value. At 0x2C3444 the hull read as a hole in
// the tarmac at this camera distance rather than as a machine above it.
const BODY = new Color().setHex(0x55688A, SRGBColorSpace)
const TRIM = new Color().setHex(0x8FA6C4, SRGBColorSpace)
const ROTOR = new Color().setHex(0xC8D8EE, SRGBColorSpace)
const LAMP_OK = new Color().setHex(0x63E8FF, SRGBColorSpace)
const LAMP_LOW = new Color().setHex(0xFF7A4A, SRGBColorSpace)
const BOLT_CORE = new Color().setHex(0xFFE9A8, SRGBColorSpace)
const BOLT_HALO = new Color().setHex(0x74D2FF, SRGBColorSpace)

const m = new Matrix4()
const _pos = new Vector3()
const _scl = new Vector3()
const _q = new Quaternion()
const _up = new Vector3(0, 1, 0)
const _dir = new Vector3()
const _dummy = new Object3D()
const tint = new Color()

/** Rotor arm offsets. A square quad reads as a drone at any silhouette size. */
const ARMS = [[-0.42, -0.34], [0.42, -0.34], [-0.42, 0.34], [0.42, 0.34]]

export function createDrones(scene) {
  const cap = CFG.pool.drones
  const boltCap = CFG.pool.bolts

  const geos = []
  const mats = []
  const keep = (arr, x) => { arr.push(x); return x }

  // ---- hull: one merged geometry so a drone is a single instanced draw -------
  const parts = []
  const chassis = new BoxGeometry(0.62, 0.17, 0.50)
  parts.push(chassis)
  const canopy = new BoxGeometry(0.30, 0.13, 0.26)
  canopy.translate(0, 0.13, -0.04)
  parts.push(canopy)
  for (const [ax, az] of ARMS) {
    const arm = new BoxGeometry(0.30, 0.055, 0.075)
    arm.rotateY(Math.atan2(az, ax))
    arm.translate(ax * 0.55, 0.02, az * 0.55)
    parts.push(arm)
    const pod = new CylinderGeometry(0.075, 0.075, 0.09, 6)
    pod.translate(ax, 0.06, az)
    parts.push(pod)
  }
  const skid = new BoxGeometry(0.50, 0.035, 0.035)
  skid.translate(0, -0.14, 0)
  parts.push(skid)
  // Drop uv before merging: BoxGeometry and CylinderGeometry disagree on uv2
  // presence, and mergeGeometries refuses a set with mismatched attributes.
  for (const p of parts) { p.deleteAttribute('uv'); p.deleteAttribute('normal') }
  const hullGeo = keep(geos, mergeGeometries(parts, false))
  for (const p of parts) p.dispose()

  const hullMat = keep(mats, new MeshBasicMaterial({ toneMapped: true }))
  const hull = new InstancedMesh(hullGeo, hullMat, cap)
  hull.castShadow = true
  hull.frustumCulled = false
  hull.count = 0
  scene.add(hull)

  // ---- rotors: one disc per arm, so cap * 4 instances ------------------------
  const rotorGeo = keep(geos, new CircleGeometry(0.20, 10).rotateX(-Math.PI * 0.5))
  const rotorMat = keep(mats, new MeshBasicMaterial({
    transparent: true, opacity: 0.30, depthWrite: false, toneMapped: false,
  }))
  const rotors = new InstancedMesh(rotorGeo, rotorMat, cap * ARMS.length)
  rotors.frustumCulled = false
  rotors.count = 0
  rotors.renderOrder = 6
  scene.add(rotors)

  // ---- status lamp ----------------------------------------------------------
  const lampGeo = keep(geos, new IcosahedronGeometry(0.075, 0))
  const lampMat = keep(mats, new MeshBasicMaterial({
    transparent: true, blending: AdditiveBlending, depthWrite: false,
    toneMapped: false, fog: false, opacity: 0.95,
  }))
  const lamps = new InstancedMesh(lampGeo, lampMat, cap)
  lamps.frustumCulled = false
  lamps.count = 0
  lamps.renderOrder = 9
  scene.add(lamps)

  // ---- bolts ----------------------------------------------------------------
  const boltGeo = keep(geos, new IcosahedronGeometry(0.13, 1))
  const boltHaloGeo = keep(geos, new IcosahedronGeometry(0.26, 1))
  const boltMat = keep(mats, new MeshBasicMaterial({ toneMapped: false, fog: false }))
  const boltHaloMat = keep(mats, new MeshBasicMaterial({
    transparent: true, opacity: 0.40, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false, fog: false,
  }))
  const bolts = new InstancedMesh(boltGeo, boltMat, boltCap)
  const boltHalo = new InstancedMesh(boltHaloGeo, boltHaloMat, boltCap)
  for (const mesh of [bolts, boltHalo]) {
    mesh.frustumCulled = false
    mesh.count = 0
    scene.add(mesh)
  }
  bolts.renderOrder = 9
  boltHalo.renderOrder = 8

  // Prime instanceColor on every mesh at boot: setColorAt() allocates the
  // attribute lazily, and the allocation re-links the program (forward AND the
  // hull's shadow-depth variant) on the exact frame the first drone appears --
  // felt as a hitch right after the reward that granted it.
  for (let i = 0; i < cap; i++) hull.setColorAt(i, BODY)
  for (let i = 0; i < cap * ARMS.length; i++) rotors.setColorAt(i, ROTOR)
  for (let i = 0; i < cap; i++) lamps.setColorAt(i, ROTOR)
  for (let i = 0; i < boltCap; i++) { bolts.setColorAt(i, BOLT_CORE); boltHalo.setColorAt(i, BOLT_HALO) }

  let clock = 0

  function sync(w, dt) {
    clock += dt > 0 ? dt : 0

    // ---- drones
    const pool = w.drones
    let n = 0
    let r = 0
    for (let i = 0; i < pool.size && n < cap; i++) {
      const d = pool.items[i]
      if (d.dead) continue

      const lifeF = d.maxLife > 0 ? d.life / d.maxLife : 1
      // Blink out over the last two seconds rather than vanishing: an escort
      // that disappears with no warning reads as a bug, not as an expiry.
      const dying = d.life < 2
      if (dying && Math.sin(d.life * 26) < -0.25) continue

      // Bank into the orbit. Sampled from the orbit phase rather than from a
      // frame delta so it is stable under interpolation and hitstop.
      const bank = Math.cos(d.phase) * 0.28
      const pitch = -0.12

      _dummy.position.set(d.x, d.y, d.z)
      _dummy.rotation.set(pitch, d.hasTarget ? Math.atan2(d.aimX - d.x, d.z - d.aimZ) : 0, bank)
      _dummy.scale.setScalar(1)
      _dummy.updateMatrix()
      hull.setMatrixAt(n, _dummy.matrix)
      hull.setColorAt(n, BODY)

      for (let a = 0; a < ARMS.length; a++) {
        const [ax, az] = ARMS[a]
        // Counter-rotating pairs, and fast enough that the disc reads as blur.
        const spin = clock * (a % 2 === 0 ? 41 : -41) + a
        _pos.set(ax, 0.115, az)
        _pos.applyEuler(_dummy.rotation).add(_dummy.position)
        _q.setFromAxisAngle(_up, spin)
        _scl.set(1, 1, 1)
        m.compose(_pos, _q, _scl)
        rotors.setMatrixAt(r, m)
        rotors.setColorAt(r, ROTOR)
        r++
      }

      _pos.set(0, -0.10, -0.20)
      _pos.applyEuler(_dummy.rotation).add(_dummy.position)
      const pulse = 0.7 + 0.3 * Math.sin(clock * (dying ? 16 : 5))
      _scl.setScalar(pulse)
      m.compose(_pos, _q.identity(), _scl)
      lamps.setMatrixAt(n, m)
      tint.copy(lifeF < 0.3 ? LAMP_LOW : LAMP_OK).multiplyScalar(pulse)
      lamps.setColorAt(n, tint)

      n++
    }
    hull.count = n
    rotors.count = r
    lamps.count = n
    hull.instanceMatrix.needsUpdate = true
    rotors.instanceMatrix.needsUpdate = true
    lamps.instanceMatrix.needsUpdate = true
    if (hull.instanceColor) hull.instanceColor.needsUpdate = true
    if (rotors.instanceColor) rotors.instanceColor.needsUpdate = true
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true
    hull.visible = n > 0
    rotors.visible = r > 0
    lamps.visible = n > 0

    // ---- bolts
    const bp = w.bolts
    let b = 0
    for (let i = 0; i < bp.size && b < boltCap; i++) {
      const p = bp.items[i]
      if (p.dead) continue

      // Orient and stretch along velocity: direction is the only thing the
      // player needs to read off a bolt.
      _dir.set(p.vx, p.vy, p.vz)
      const speed = _dir.length() || 1
      _dir.multiplyScalar(1 / speed)
      _q.setFromUnitVectors(_up, _dir)
      _pos.set(p.x, p.y, p.z)
      _scl.set(0.85, 2.3, 0.85)
      m.compose(_pos, _q, _scl)
      bolts.setMatrixAt(b, m)
      bolts.setColorAt(b, BOLT_CORE)

      _scl.set(1.0, 1.7, 1.0)
      m.compose(_pos, _q, _scl)
      boltHalo.setMatrixAt(b, m)
      boltHalo.setColorAt(b, BOLT_HALO)
      b++
    }
    bolts.count = b
    boltHalo.count = b
    bolts.instanceMatrix.needsUpdate = true
    boltHalo.instanceMatrix.needsUpdate = true
    if (bolts.instanceColor) bolts.instanceColor.needsUpdate = true
    if (boltHalo.instanceColor) boltHalo.instanceColor.needsUpdate = true
    bolts.visible = b > 0
    boltHalo.visible = b > 0
  }

  function reset() {
    for (const mesh of [hull, rotors, lamps, bolts, boltHalo]) {
      mesh.count = 0
      mesh.visible = false
    }
  }

  function dispose() {
    for (const mesh of [hull, rotors, lamps, bolts, boltHalo]) scene.remove(mesh)
    for (const g of geos) g.dispose()
    for (const mt of mats) mt.dispose()
  }

  return { sync, reset, dispose }
}
