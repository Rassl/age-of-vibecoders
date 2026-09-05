/** Roadside silhouettes, merged once and instanced. Scroll derives from distance. */
import {
  BoxGeometry, CylinderGeometry, BufferAttribute, Color, InstancedMesh,
  Matrix4, MeshStandardMaterial,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const color = new Color()
function part(g, hex, x, y, z) {
  g.translate(x, y, z)
  const flat = g.index ? g.toNonIndexed() : g
  if (flat !== g) g.dispose()
  flat.deleteAttribute('uv')
  color.setHex(hex)
  const a = new Float32Array(flat.attributes.position.count * 3)
  for (let i = 0; i < a.length; i += 3) color.toArray(a, i)
  flat.setAttribute('color', new BufferAttribute(a, 3))
  return flat
}
function builder() {
  const parts = []
  return {
    box(w, h, d, c, x, y, z) { parts.push(part(new BoxGeometry(w, h, d), c, x, y, z)) },
    cylinder(r, h, c, x, y, z, wheel = false) {
      const g = new CylinderGeometry(r, r, h, 10)
      if (wheel) g.rotateZ(Math.PI / 2)
      parts.push(part(g, c, x, y, z))
    },
    finish() { const g = mergeGeometries(parts); for (const p of parts) p.dispose(); return g },
  }
}
function lamp() {
  const b = builder()
  b.box(.65, .28, .65, 0xaca18a, 0, .14, 0)
  b.box(.15, 5.8, .18, 0x405664, 0, 2.9, 0)
  b.box(1.8, .13, .16, 0x506b79, -.75, 5.75, 0)
  b.box(.8, .16, .44, 0x1c303e, -1.3, 5.64, 0)
  b.box(.68, .035, .33, 0xffe6a2, -1.3, 5.54, 0)
  b.box(.22, .52, .23, 0xc7994c, 0, 1.15, 0)
  return b.finish()
}
function outpost() {
  const b = builder()
  // Raised observation cabin with open legs and external ladder.
  for (const x of [-1.2, 1.2]) for (const z of [-1.2, 1.2]) {
    b.box(.18, 3.1, .18, 0x46535a, x, 1.55, z)
  }
  b.box(3.1, .23, 3.1, 0x384853, 0, 3.05, 0)
  b.box(2.65, 1.15, 2.65, 0x8c9c99, 0, 3.72, 0)
  b.box(2.72, .7, 2.72, 0x203b49, 0, 4.56, 0)
  for (const x of [-1.28, 0, 1.28]) {
    b.box(.10, .8, 2.78, 0xb6b8a2, x, 4.55, 0)
  }
  b.box(3.25, .19, 3.25, 0x51626b, 0, 5.02, 0)
  b.cylinder(.04, 1.6, 0x303e48, .8, 5.9, .5)
  for (const x of [-.42, .42]) b.box(.07, 3.05, .07, 0x9fa9a5, x, 1.5, 1.62)
  for (let i = 0; i < 9; i++) b.box(.9, .06, .07, 0x7f9498, 0, .25 + i * .32, 1.62)
  b.box(1.5, .16, .04, 0xd8b775, 0, 3.65, 1.35)
  return b.finish()
}
function truck() {
  const b = builder()
  b.box(1.9, .3, 4.3, 0x24333b, 0, .55, 0)
  b.box(2.05, .68, 1.65, 0x9d704e, 0, 1.02, -1.3)
  b.box(1.9, .85, 1.3, 0x856549, 0, 1.76, -.7)
  b.box(1.64, .53, .035, 0x183440, 0, 1.87, -1.37)
  for (const side of [-1, 1]) {
    b.box(.025, .5, .91, 0x183440, side * .96, 1.87, -.7)
    b.box(.1, .58, 2.05, 0x7b694f, side, 1.15, 1)
    for (const z of [-1.25, 1.2]) {
      b.cylinder(.48, .3, 0x17212a, side * 1.02, .48, z, true)
      b.cylinder(.23, .32, 0x64747b, side * 1.04, .48, z, true)
    }
    b.box(.28, .18, .06, 0xe8c789, side * .69, 1.1, -2.15)
  }
  b.box(1.1, .22, .05, 0x26353d, 0, .91, -2.15)
  b.box(2.18, .16, .2, 0x637178, 0, .68, -2.2)
  b.box(2, .15, 2.1, 0x5a5144, 0, .91, 1)
  return b.finish()
}

export function createScenery(group) {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: .76, metalness: .22 })
  const specs = [
    { geo: lamp(), count: 12, step: 22, x: 5.8, offset: 6 },
    { geo: outpost(), count: 4, step: 64, x: 10.4, offset: 24 },
    { geo: truck(), count: 7, step: 36, x: 7.8, offset: 12 },
  ]
  const matrix = new Matrix4()
  for (const spec of specs) {
    spec.mesh = new InstancedMesh(spec.geo, material, spec.count)
    spec.mesh.castShadow = true
    spec.mesh.receiveShadow = true
    spec.mesh.frustumCulled = false
    group.add(spec.mesh)
  }
  return {
    sync(distance) {
      for (const spec of specs) {
        const first = Math.floor((distance - 18 - spec.offset) / spec.step)
        for (let i = 0; i < spec.count; i++) {
          const ordinal = first + i
          const side = ordinal % 2 === 0 ? 1 : -1
          const z = distance - ordinal * spec.step - spec.offset
          const yaw = spec === specs[2] ? side * .28 : side < 0 ? Math.PI : 0
          matrix.makeRotationY(yaw)
          matrix.setPosition(side * spec.x, -.06, z)
          spec.mesh.setMatrixAt(i, matrix)
        }
        spec.mesh.instanceMatrix.needsUpdate = true
      }
    },
    dispose() {
      for (const spec of specs) { group.remove(spec.mesh); spec.geo.dispose() }
      material.dispose()
    },
  }
}
