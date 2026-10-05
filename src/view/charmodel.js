/**
 * Character bodies modelled in Blender, swapped in over the procedural ones.
 *
 * The body must honour the same contract as view/geometry.js, because the
 * pose runs in the vertex shader (charShader in characters.js) and a loaded
 * mesh gets no say in it: facing +Z for enemies, a per-vertex limb tag, and a
 * vertex colour (multiplied into the texture, if the model has one). In
 * Blender the tag is a float point attribute named `_limbid` (exported with
 * "custom attributes"), holding the LIMB numbers from geometry.js.
 *
 * A model may describe itself through glTF extras on its mesh node:
 *   aovRig   joint pivots measured on THIS mesh, overriding the kind's rig
 *            (hipY, kneeY, legX, shoulderY, shoulderX, neckY)
 *   aovAnim  gait overrides for the kind's ANIM row -- a mesh posed mid-stride
 *            wants a smaller swing than a procedural body standing straight
 *
 * Fire-and-forget: on a 404 or a mesh without tags `onModel` never runs and
 * the caller keeps its procedural body.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * @param {string} url
 * @param {(m: {geometry: BufferGeometry, map: import('three').Texture|null,
 *   rig: object, anim: object}) => void} onModel
 */
export function loadCharacterModel(url, onModel) {
  new GLTFLoader().load(url, (gltf) => {
    let mesh = null
    gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o })
    const src = mesh && mesh.geometry
    const a = src && src.attributes
    if (!a || !a._limbid || !a.color || !a.normal) {
      console.warn('character model needs colour, normals and a _limbid attribute:', url)
      return
    }
    // Non-indexed like every procedural body, and only the attributes
    // charShader and the material read.
    const g = src.index ? src.toNonIndexed() : src
    const n = g.attributes.position.count
    const col = g.attributes.color
    const rgb = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = col.getX(i)
      rgb[i * 3 + 1] = col.getY(i)
      rgb[i * 3 + 2] = col.getZ(i)
    }
    const out = new BufferGeometry()
    out.setAttribute('position', g.attributes.position.clone())
    out.setAttribute('normal', g.attributes.normal.clone())
    out.setAttribute('color', new BufferAttribute(rgb, 3))
    out.setAttribute('limbId', g.attributes._limbid.clone())
    if (g.attributes.uv) out.setAttribute('uv', g.attributes.uv.clone())
    out.computeBoundingSphere()
    if (g !== src) g.dispose()
    src.dispose()

    const map = (mesh.material && mesh.material.map) || null
    const extras = mesh.userData || {}
    onModel({ geometry: out, map, rig: extras.aovRig || {}, anim: extras.aovAnim || {} })
  }, undefined, () => console.warn('no character model at', url))
}
