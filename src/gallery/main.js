/**
 * DEV-ONLY asset gallery: every character and item, one at a time, on a
 * turntable -- so a silhouette can be judged and improved in isolation instead
 * of at 40px inside a running game. Served by `npm run dev` at /gallery.html;
 * `vite build` never bundles it.
 *
 * Faithfulness rule: characters compile through the SAME charShader pose code
 * and gait tables as the game (exported from view/characters.js), the boss
 * wears the same GLTF head via view/bosshead.js, and item geometry comes from
 * the shipped builders. Only lighting differs: no fog and no danger grade,
 * because the point here is to SEE the asset.
 */
import {
  ACESFilmicToneMapping, AdditiveBlending, Box3, CircleGeometry, Clock, Color,
  DirectionalLight, GridHelper, Group, HemisphereLight, IcosahedronGeometry,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, PCFShadowMap, PerspectiveCamera,
  PlaneGeometry, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { CFG } from '../config.js'
import {
  ANIM, GUN_SPIN_EXTRA, KINDS, KIND_TINT, charShader, enemyShaderOpts,
} from '../view/characters.js'
import {
  BOSS_RIG, ENEMY_RIGS, GUN_POSES, SOLDIER_RIG,
  buildBloaterGeometry, buildBossGeometry, buildBruteGeometry, buildGunGeometries,
  buildRunnerGeometry, buildSoldierGeometry, buildSpitterGeometry, buildWalkerGeometry,
} from '../view/geometry.js'
import { createBossHead } from '../view/bosshead.js'
import {
  buildDroneToken, buildMinigun, buildNarrowClusterGeometry, buildSoldierTrio,
  buildWallClusterGeometry,
} from '../view/props.js'
import { buildDroneHullGeometry } from '../view/drones.js'
import { buildWatermelonGeometry } from '../fx/melons.js'
import { WEAPONS } from '../data/weapons.js'

const TAU = Math.PI * 2

// One uniform set shared by every character material: the control panel writes
// here once and whichever entry is on stage reads it.
const U = {
  aPhase: { value: 0 },
  aFlash: { value: 0 },
  aDrive: { value: 0 },
  aGait: { value: 1 },
  aTint: { value: new Color(1, 1, 1) },
  uTime: { value: 0 },
  uArm: { value: new Vector2(GUN_POSES[0].armL, GUN_POSES[0].armR) },
  uSpin: { value: 0 },
}

function charMesh(geo, rig, anim, opt, emissive) {
  const mat = charShader(
    new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive }),
    rig, anim, { ...opt, instanced: false, uniforms: U },
  )
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  mesh.customDepthMaterial = mat.userData.depthMaterial
  return mesh
}

function staticMesh(geo, mat) {
  const mesh = new Mesh(geo, mat)
  mesh.castShadow = true
  return mesh
}

const lambert = (o) => new MeshLambertMaterial({ flatShading: true, ...o })

// ------------------------------------------------------------------- entries
// build() runs once, on first select, and the object is cached after.
// hz is cycles/second on the gait phase; entries without it render static.

const gunGeos = buildGunGeometries()
const gunNames = WEAPONS.map((w) => w.name)

const entries = []

entries.push({
  group: 'Squad', name: 'Soldier', hz: 2.55 / TAU, tint: [1, 1, 1], tierPick: true, facing: Math.PI,
  build() {
    const g = new Group()
    g.add(charMesh(buildSoldierGeometry(), SOLDIER_RIG, ANIM.soldier,
      { key: 'g-soldier', face: 1, armPose: true }, 0x101c28))
    const gun = charMesh(gunGeos[0], SOLDIER_RIG, ANIM.soldier,
      { key: 'g-gun', face: 1, spin: true, extra: GUN_SPIN_EXTRA }, 0x0c1016)
    gun.name = 'gun'
    g.add(gun)
    return g
  },
})

const kindHz = { walker: 0.9, runner: 1.7, brute: 0.8, spitter: 0.9, bloater: 0.7 }
const enemyGeoFns = {
  walker: buildWalkerGeometry, runner: buildRunnerGeometry, brute: buildBruteGeometry,
  spitter: buildSpitterGeometry, bloater: buildBloaterGeometry,
}
for (const kind of KINDS) {
  entries.push({
    group: 'Horde', name: kind[0].toUpperCase() + kind.slice(1),
    hz: kindHz[kind], tint: KIND_TINT[KINDS.indexOf(kind)],
    build() {
      const opt = enemyShaderOpts(kind)
      opt.key = 'g-' + kind
      return charMesh(enemyGeoFns[kind](), ENEMY_RIGS[kind], ANIM[kind], opt, 0x161a12)
    },
  })
}

entries.push({
  group: 'Boss', name: 'Boss', hz: 0.55, tint: [1, 1, 1], boss: true,
  build() {
    const mesh = charMesh(buildBossGeometry(), BOSS_RIG, ANIM.boss,
      { key: 'g-boss', face: -1, lump: true, fresnelFlash: true, rimExp: 2.0 }, 0x1a1020)
    const head = createBossHead(BOSS_RIG, ANIM.boss, CFG.boss.headModelUrl, () => {
      mesh.geometry.dispose()
      mesh.geometry = buildBossGeometry(false)
    })
    mesh.add(head.group)
    this.head = head
    return mesh
  },
})

entries.push({
  group: 'Boss', name: 'Boss head (model)',
  build() {
    const g = new Group()
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    loader.load(CFG.boss.headModelUrl, (gltf) => {
      const model = gltf.scene
      const box = new Box3().setFromObject(model)
      const size = box.getSize(new Vector3())
      const center = box.getCenter(new Vector3())
      const s = 2 / Math.max(size.x, size.y, size.z, 0.001)
      model.scale.setScalar(s)
      model.position.copy(center).multiplyScalar(-s).add(new Vector3(0, size.y * s * 0.5 + 0.2, 0))
      model.traverse((o) => { if (o.isMesh) o.castShadow = true })
      g.add(model)
      frame(g) // reframe once the async load lands
    }, undefined, () => console.warn('no boss head model at', CFG.boss.headModelUrl))
    return g
  },
})

for (let t = 0; t < gunGeos.length; t++) {
  entries.push({
    group: 'Weapons', name: gunNames[t] || `Tier ${t}`,
    build: () => staticMesh(gunGeos[t], lambert({ vertexColors: true })),
  })
}

entries.push({
  group: 'Items', name: 'Barrel cluster',
  note: 'in game: hazard texture + HP wipe shader',
  build: () => staticMesh(buildNarrowClusterGeometry(), lambert({ color: 0x9e3b2c })),
})
entries.push({
  group: 'Items', name: 'Barricade wall',
  note: 'in game: hazard texture + HP wipe shader',
  build: () => staticMesh(buildWallClusterGeometry(), lambert({ color: 0x9e3b2c })),
})
entries.push({
  group: 'Items', name: 'Escort drone',
  build() {
    const g = new Group()
    // Same cosmetics as createDrones: flat-colour hull, blurred rotor discs, lamp.
    const hull = new Mesh(buildDroneHullGeometry(), new MeshBasicMaterial({ color: 0x55688A }))
    hull.castShadow = true
    g.add(hull)
    const rotorGeo = new CircleGeometry(0.20, 10).rotateX(-Math.PI * 0.5)
    const rotorMat = new MeshBasicMaterial({
      color: 0xC8D8EE, transparent: true, opacity: 0.30, depthWrite: false,
    })
    for (const [ax, az] of [[-0.42, -0.34], [0.42, -0.34], [-0.42, 0.34], [0.42, 0.34]]) {
      const r = new Mesh(rotorGeo, rotorMat)
      r.position.set(ax, 0.13, az)
      g.add(r)
    }
    const lamp = new Mesh(new IcosahedronGeometry(0.075, 0), new MeshBasicMaterial({
      color: 0x63E8FF, transparent: true, blending: AdditiveBlending, depthWrite: false,
    }))
    lamp.position.set(0, 0.22, -0.06)
    g.add(lamp)
    g.position.y = 1.0
    const wrap = new Group()
    wrap.add(g)
    return wrap
  },
})
entries.push({
  group: 'Items', name: 'Boss watermelon',
  note: 'rolls at the squad in rows during the slam',
  build: () => liftedToken(buildWatermelonGeometry()),
})
entries.push({
  group: 'Items', name: 'Reward: soldier trio',
  build: () => liftedToken(buildSoldierTrio()),
})
entries.push({
  group: 'Items', name: 'Reward: drone token',
  build: () => liftedToken(buildDroneToken()),
})
entries.push({
  group: 'Items', name: 'Reward: minigun',
  build: () => liftedToken(buildMinigun()),
})

/** Bubble contents float at bubble height in game; lift them off the grid here. */
function liftedToken(geo) {
  const mesh = staticMesh(geo, lambert({ vertexColors: true }))
  mesh.position.y = 0.6
  const wrap = new Group()
  wrap.add(mesh)
  return wrap
}

// --------------------------------------------------------------------- stage

const stage = document.getElementById('stage')
const renderer = new WebGLRenderer({ antialias: true })
renderer.outputColorSpace = SRGBColorSpace
renderer.toneMapping = ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFShadowMap
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
stage.prepend(renderer.domElement)

const scene = new Scene()
// Mid-value warm ground and sky: bright enough to judge a silhouette, not so
// bright that dark kits (soldier navy) silhouette into a void.
scene.background = new Color(0x4a4136)

const camera = new PerspectiveCamera(38, 1, 0.05, 200)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

// The corridor's own three-light rig, minus fog and the danger grade -- with
// everything pushed brighter, because there is no bright sand bouncing light
// around here and an inspection stage must never hide a face in shadow.
const hemi = new HemisphereLight(0xbfd8ff, 0xc89b62, 0.95)
const key = new DirectionalLight(0xffe7c2, 1.75)
key.position.set(-20, 25, 15)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
key.shadow.camera.left = key.shadow.camera.bottom = -12
key.shadow.camera.right = key.shadow.camera.top = 12
const rim = new DirectionalLight(0x9db8ff, 0.55)
rim.position.set(10, 14, -24)
scene.add(hemi, key, key.target, rim, rim.target)

const ground = new Mesh(new PlaneGeometry(80, 80).rotateX(-Math.PI * 0.5),
  new MeshLambertMaterial({ color: 0x776b58 }))
ground.receiveShadow = true
scene.add(ground)
const grid = new GridHelper(40, 40, 0x6b5c43, 0x352b20)
scene.add(grid)

const pivot = new Group()
scene.add(pivot)

// ----------------------------------------------------------------------- ui

const side = document.getElementById('side')
const el = (id) => document.getElementById(id)
const hzEl = el('hz'), gaitEl = el('gait'), driveEl = el('drive')
const tierSel = el('tier')

for (let t = 0; t < gunNames.length; t++) {
  const o = document.createElement('option')
  o.value = t
  o.textContent = `${t} · ${gunNames[t]}`
  tierSel.appendChild(o)
}

let active = null
let playing = true
let phase = 0
let spin = 0
let spinRate = 0

function frame(obj) {
  const box = new Box3().setFromObject(obj)
  if (box.isEmpty()) { camera.position.set(3, 2, 5); controls.target.set(0, 1, 0); return }
  const size = box.getSize(new Vector3())
  const center = box.getCenter(new Vector3())
  const dim = Math.max(size.x, size.y, size.z)
  controls.target.copy(center)
  camera.position.set(center.x + dim * 0.45, center.y + dim * 0.35, center.z + dim * 1.55)
  camera.near = Math.max(0.02, dim / 100)
  camera.far = dim * 40 + 60
  camera.updateProjectionMatrix()
}

function select(entry, btn) {
  for (const b of side.querySelectorAll('button')) b.classList.remove('on')
  btn.classList.add('on')
  if (active && active.obj) pivot.remove(active.obj)
  if (!entry.obj) entry.obj = entry.build()
  active = entry
  pivot.add(entry.obj)
  pivot.rotation.y = 0
  entry.obj.rotation.y = entry.facing || 0

  phase = 0
  U.aPhase.value = 0
  U.aFlash.value = 0
  U.aDrive.value = Number(driveEl.value)
  U.aTint.value.setRGB(...(entry.tint || [1, 1, 1]))
  hzEl.value = entry.hz || 0
  el('bossrow').hidden = !entry.boss
  el('tierrow').hidden = !entry.tierPick
  applyWireframe()
  frame(entry.obj)
  updateStats()
}

let groupLabel = ''
for (const entry of entries) {
  if (entry.group !== groupLabel) {
    groupLabel = entry.group
    const h = document.createElement('h2')
    h.textContent = groupLabel
    side.appendChild(h)
  }
  const b = document.createElement('button')
  b.textContent = entry.name
  b.addEventListener('click', () => select(entry, b))
  side.appendChild(b)
  entry.btn = b
}

el('play').addEventListener('click', () => {
  playing = !playing
  el('play').textContent = playing ? 'pause' : 'play'
})
el('flash').addEventListener('click', () => { U.aFlash.value = 1 })
tierSel.addEventListener('change', () => {
  const t = Number(tierSel.value)
  const gun = active && active.obj && active.obj.getObjectByName('gun')
  if (gun) gun.geometry = gunGeos[t]
  U.uArm.value.set(GUN_POSES[t].armL, GUN_POSES[t].armR)
  spinRate = (WEAPONS[t] && WEAPONS[t].spin) || 0
})

function applyWireframe() {
  const on = el('wire').checked
  if (active && active.obj) {
    active.obj.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) if ('wireframe' in m) m.wireframe = on
    })
  }
}
el('wire').addEventListener('change', applyWireframe)

function updateStats() {
  const r = renderer.info.render
  el('stats').textContent =
    `${active ? active.name : ''}  ·  ${r.triangles} tris  ·  ${r.calls} draws` +
    (active && active.note ? `  ·  ${active.note}` : '')
}

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

// --------------------------------------------------------------------- loop

const clock = new Clock()

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  el('hzv').textContent = Number(hzEl.value).toFixed(2)
  el('gaitv').textContent = Number(gaitEl.value).toFixed(2)
  el('drivev').textContent = Number(driveEl.value).toFixed(2)

  if (playing) phase += Number(hzEl.value) * dt
  U.aPhase.value = phase * TAU
  U.aGait.value = Number(gaitEl.value)
  U.aDrive.value = Number(driveEl.value)
  U.uTime.value += dt
  if (U.aFlash.value > 0) U.aFlash.value = Math.max(0, U.aFlash.value - CFG.fx.hitFlashDecay * dt)

  if (active && active.boss) {
    const raging = el('rage').checked ? 1 : 0
    U.aTint.value.setRGB(1 + raging * 0.35, 1 - raging * 0.12, 1 - raging * 0.08)
    if (active.head) {
      active.head.sync(U.aPhase.value, U.aGait.value, U.aDrive.value, U.aFlash.value, U.aTint.value)
    }
  }

  spin += spinRate * Number(driveEl.value) * dt
  if (spin > TAU) spin -= TAU
  U.uSpin.value = spin

  if (el('turn').checked) pivot.rotation.y += dt * 0.5

  controls.update()
  renderer.render(scene, camera)
  updateStats()
})

select(entries[0], entries[0].btn)
