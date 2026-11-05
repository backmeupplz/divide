import * as THREE from 'three'
import { FACTIONS, NEUTRAL_COLOR } from '../shared/factions'
import { planet, type Planet } from '../shared/planet'
import { FLAG_ALIVE, tileOwner, tileTrail, type PlayerView } from '../shared/protocol'

const MAX_PLAYERS = 128
/** how far behind the newest server state players are drawn, so motion stays smooth between ticks */
const INTERP_MS = 110
const TICK_MS = 1000 / 15

const factionColor = FACTIONS.map((f) => new THREE.Color(f.color))
const trailColor = FACTIONS.map((f) => new THREE.Color(f.color).lerp(new THREE.Color('#ffffff'), 0.35))
const neutral = new THREE.Color(NEUTRAL_COLOR)
const CORE_COLD = new THREE.Color('#2a0f1f')
const CORE_HOT = new THREE.Color('#ff7a1a')
const FOG = '#1d1430'

type Sample = { t: number; players: Map<number, PlayerView> }

/** a hexagonal prism without a bottom: unit circumradius, height 1, base at y = 0 */
function hexPrism() {
  const pos: number[] = []
  const ring = [...Array(6)].map((_, k) => [Math.cos((Math.PI / 3) * k + Math.PI / 6), Math.sin((Math.PI / 3) * k + Math.PI / 6)])
  for (let k = 0; k < 6; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % 6]
    pos.push(0, 1, 0, bx, 1, bz, ax, 1, az)
    pos.push(ax, 0, az, ax, 1, az, bx, 1, bz, ax, 0, az, bx, 1, bz, bx, 0, bz)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
  planet: Planet | null = null
  tiles: Uint8Array = new Uint8Array(0)
  /** 0 at round start, 1 at its end: how wide the cracks between factions are */
  crack = 0
  zoom = 1
  me = 0
  /** the menu's slowly turning planet, hanging in the sky over the street */
  attract = false
  private tileMesh: THREE.InstancedMesh | null = null
  private tileTone = new Float32Array(0)
  private border = new Uint8Array(0)
  private appliedCrack = -1
  private fullUpload = false
  private playerMesh: THREE.InstancedMesh
  private halo: THREE.Mesh
  private core: THREE.Mesh
  private coreMat: THREE.MeshBasicMaterial
  private samples: Sample[] = []
  private offsets: number[] = []
  private offset = 0
  private up = new THREE.Vector3(0, 1, 0)
  private mePos = new THREE.Vector3(0, 0, 1)
  /** interpolated positions this frame, for labels */
  readonly drawn = new Map<number, { pos: THREE.Vector3; faction: number; alive: boolean }>()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3()
  private yAxis = new THREE.Vector3(0, 1, 0)

  constructor(canvas: HTMLCanvasElement) {
    // transparent, so the rainy dusk sky drawn behind the canvas shows through
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.setClearColor(0x000000, 0)
    this.scene.fog = new THREE.Fog(FOG, 1, 10)
    this.scene.add(new THREE.HemisphereLight('#9fb0ff', '#2a1430', 1.25))
    const lamp = new THREE.DirectionalLight('#ffe2c4', 1.35)
    lamp.position.set(0.4, 1, 0.6)
    this.camera.add(lamp)
    // pink and violet neon from either side, for glints on the wet tiles
    const pink = new THREE.DirectionalLight('#ff4fa3', 0.35)
    pink.position.set(-1, 0.4, 0.3)
    this.camera.add(pink)
    const violet = new THREE.DirectionalLight('#9b5cff', 0.35)
    violet.position.set(1, 0.4, 0.3)
    this.camera.add(violet)
    this.scene.add(this.camera)

    this.coreMat = new THREE.MeshBasicMaterial({ color: CORE_COLD })
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.975, 5), this.coreMat)
    this.scene.add(this.core)
    this.scene.add(atmosphere())

    this.playerMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ emissive: '#222222' }), MAX_PLAYERS)
    this.playerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.playerMesh.count = 0
    this.playerMesh.frustumCulled = false
    this.scene.add(this.playerMesh)
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 6, 24), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
    this.halo.visible = false
    this.scene.add(this.halo)
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  setPlanet(subdiv: number, tiles: Uint8Array) {
    const pl = planet(subdiv)
    if (this.planet !== pl) {
      if (this.tileMesh) {
        this.scene.remove(this.tileMesh)
        this.tileMesh.dispose()
      }
      this.planet = pl
      // shiny, so the ground reads as wet asphalt catching the neon
      const mesh = new THREE.InstancedMesh(hexPrism(), new THREE.MeshPhongMaterial({ shininess: 60, specular: '#2a2636' }), pl.count)
      mesh.frustumCulled = false
      this.tileMesh = mesh
      this.tileTone = new Float32Array(pl.count)
      // a little per-tile variation keeps big territories from looking flat
      for (let i = 0; i < pl.count; i++) this.tileTone[i] = 0.9 + 0.2 * fract(Math.sin(i * 12.9898) * 43758.5453)
      this.border = new Uint8Array(pl.count)
      this.scene.add(mesh)
      const c = new THREE.Color()
      for (let i = 0; i < pl.count; i++) mesh.setColorAt(i, c)
    }
    this.tiles = tiles.slice()
    for (let i = 0; i < pl.count; i++) this.border[i] = this.isBorder(i) ? 1 : 0
    for (let i = 0; i < pl.count; i++) this.drawTile(i)
    this.fullUpload = true
    this.appliedCrack = this.crackStep()
  }

  setTile(i: number, b: number) {
    const pl = this.planet
    if (!pl || i >= pl.count || this.tiles[i] === b) return
    this.tiles[i] = b
    this.drawTile(i)
    this.touch(i)
    for (let k = pl.nbrStart[i]; k < pl.nbrStart[i + 1]; k++) {
      const j = pl.nbr[k]
      const was = this.border[j]
      this.border[j] = this.isBorder(j) ? 1 : 0
      if (was !== this.border[j]) {
        this.drawTile(j)
        this.touch(j)
      }
    }
    const was = this.border[i]
    this.border[i] = this.isBorder(i) ? 1 : 0
    if (was !== this.border[i]) this.drawTile(i)
  }

  private touch(i: number) {
    const mesh = this.tileMesh!
    if (this.fullUpload) return
    if (mesh.instanceMatrix.updateRanges.length > 256) {
      // a big capture: one full upload beats hundreds of small ones
      this.fullUpload = true
      return
    }
    mesh.instanceMatrix.addUpdateRange(i * 16, 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.addUpdateRange(i * 3, 3)
    mesh.instanceColor!.needsUpdate = true
  }

  /** a tile between two different factions */
  private isBorder(i: number) {
    const pl = this.planet!
    const o = tileOwner(this.tiles[i])
    if (!o) return false
    for (let k = pl.nbrStart[i]; k < pl.nbrStart[i + 1]; k++) {
      const n = tileOwner(this.tiles[pl.nbr[k]])
      if (n && n !== o) return true
    }
    return false
  }

  private crackStep() {
    return Math.round(this.crack * 12)
  }

  private drawTile(i: number) {
    const pl = this.planet!
    const mesh = this.tileMesh!
    const b = this.tiles[i]
    const owner = tileOwner(b)
    const trail = tileTrail(b)
    const sp = pl.spacing
    const top = trail ? 0.24 * sp : owner ? 0.13 * sp : 0
    const bottom = -0.04
    const crack = this.crackStep() / 12
    const radius = sp * 0.575 * (this.border[i] ? 1 - 0.5 * crack : 0.94)
    this.v.set(pl.pos[i * 3], pl.pos[i * 3 + 1], pl.pos[i * 3 + 2])
    this.q.setFromUnitVectors(this.yAxis, this.v)
    this.s.set(radius, top - bottom, radius)
    this.v.multiplyScalar(1 + bottom)
    this.m.compose(this.v, this.q, this.s)
    mesh.setMatrixAt(i, this.m)
    const c = trail ? trailColor[trail - 1] : owner ? factionColor[owner - 1] : neutral
    mesh.setColorAt(i, new THREE.Color(c).multiplyScalar(trail ? 1 : this.tileTone[i]))
  }

  /** called with every server tick, in arrival order */
  addTick(tick: number, players: PlayerView[]) {
    const now = performance.now()
    // the smallest arrival delay seen lately maps server ticks onto local time
    this.offsets.push(now - tick * TICK_MS)
    if (this.offsets.length > 40) this.offsets.shift()
    this.offset = Math.min(...this.offsets)
    const map = new Map<number, PlayerView>()
    for (const p of players) map.set(p.id, p)
    this.samples.push({ t: tick * TICK_MS, players: map })
    if (this.samples.length > 12) this.samples.shift()
  }

  resetTimeline() {
    this.samples = []
    this.offsets = []
  }

  /** the direction on the planet's surface that points "up" on screen at the player */
  get screenUp() {
    return this.up
  }

  get playerPos() {
    return this.mePos
  }

  frame() {
    const pl = this.planet
    if (!pl || !this.tileMesh) {
      this.renderer.render(this.scene, this.camera)
      return
    }
    if (this.crackStep() !== this.appliedCrack) {
      this.appliedCrack = this.crackStep()
      for (let i = 0; i < pl.count; i++) if (this.border[i]) this.drawTile(i)
      this.fullUpload = true
    }
    if (this.fullUpload) {
      this.fullUpload = false
      for (const a of [this.tileMesh.instanceMatrix, this.tileMesh.instanceColor!]) {
        a.clearUpdateRanges()
        a.needsUpdate = true
      }
    }
    // the cracks between territories glow hotter as the round runs out
    this.coreMat.color.copy(CORE_COLD).lerp(CORE_HOT, 0.12 + 0.88 * this.crack)
    this.interpolate()
    const fog = this.scene.fog as THREE.Fog
    if (this.attract) {
      // the whole planet, slowly turning, pushed up into the sky above the street
      const portrait = this.camera.aspect < 1
      const dist = portrait ? 7 : 4.8
      const a = performance.now() / 26000
      this.camera.up.set(0, 1, 0)
      this.camera.position.set(Math.sin(a) * dist, dist * 0.18, Math.cos(a) * dist)
      this.camera.lookAt(0, portrait ? -1.3 : -0.55, 0)
      fog.near = dist - 0.6
      fog.far = dist + 1.6
      this.drawPlayers(pl)
      this.renderer.render(this.scene, this.camera)
      return
    }
    // camera: above the player, tilted back, with "up" carried along the surface so it never spins
    const me = this.drawn.get(this.me)
    if (me) this.mePos.copy(me.pos).normalize()
    const p = this.mePos
    this.up.addScaledVector(p, -this.up.dot(p))
    if (this.up.lengthSq() < 1e-6) this.up.set(0, 1, 0).addScaledVector(p, -p.y).normalize()
    this.up.normalize()
    const portrait = this.camera.aspect < 1
    const d = pl.spacing * 12 * this.zoom * (portrait ? 1.4 : 1)
    this.camera.position.copy(p).multiplyScalar(1 + d).addScaledVector(this.up, -d * 0.32)
    this.camera.up.copy(this.up)
    this.camera.lookAt(this.v.copy(p).addScaledVector(this.up, d * 0.08))
    // the far side of the visible cap fades into the rainy haze
    fog.near = d * 1.5
    fog.far = d * 5
    this.drawPlayers(pl)
    this.renderer.render(this.scene, this.camera)
  }

  private interpolate() {
    this.drawn.clear()
    const n = this.samples.length
    if (!n) return
    const t = performance.now() - this.offset - INTERP_MS
    let a = this.samples[0], b = this.samples[0]
    for (let i = 0; i < n; i++) {
      if (this.samples[i].t <= t) a = this.samples[i]
      if (this.samples[i].t >= t) {
        b = this.samples[i]
        break
      }
      b = this.samples[i]
    }
    const span = b.t - a.t
    const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id)
      const pos = new THREE.Vector3(pb.x, pb.y, pb.z)
      if (pa && pa.flags & FLAG_ALIVE && pb.flags & FLAG_ALIVE) {
        const from = new THREE.Vector3(pa.x, pa.y, pa.z)
        // no smoothing across a respawn jump
        if (from.dot(pos) > 0.98) pos.copy(from.lerp(pos, k)).normalize()
      }
      this.drawn.set(id, { pos, faction: pb.faction, alive: (pb.flags & FLAG_ALIVE) !== 0 })
    }
  }

  private drawPlayers(pl: Planet) {
    const mesh = this.playerMesh
    let i = 0
    const size = pl.spacing * 0.5
    const spin = performance.now() / 600
    const color = new THREE.Color()
    this.halo.visible = false
    for (const [id, d] of this.drawn) {
      if (!d.alive || i >= MAX_PLAYERS) continue
      const lift = 1 + pl.spacing * 1.05
      this.v.copy(d.pos).multiplyScalar(lift)
      this.q.setFromUnitVectors(this.yAxis, d.pos)
      this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.yAxis, spin + id))
      this.s.set(size, size * 1.4, size)
      this.m.compose(this.v, this.q, this.s)
      mesh.setMatrixAt(i, this.m)
      mesh.setColorAt(i, color.copy(factionColor[d.faction - 1] ?? neutral).lerp(new THREE.Color('#ffffff'), id === this.me ? 0.35 : 0.1))
      if (id === this.me) {
        this.halo.visible = true
        this.halo.position.copy(d.pos).multiplyScalar(1 + pl.spacing * 0.2)
        this.halo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.pos)
        const r = pl.spacing * (0.75 + 0.08 * Math.sin(spin * 4))
        this.halo.scale.set(r, r, r)
      }
      i++
    }
    mesh.count = i
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  /** screen position (CSS pixels) of a point on the planet, or null when it faces away */
  project(pos: THREE.Vector3, w: number, h: number) {
    const camDir = this.v.copy(this.camera.position).normalize()
    if (pos.dot(camDir) < 0.2) return null
    const p = pos.clone().multiplyScalar(1 + (this.planet?.spacing ?? 0.05) * 1.4).project(this.camera)
    if (p.z > 1) return null
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h }
  }

  /** world direction on the surface for a screen-space direction (x right, y up) */
  worldDir(sx: number, sy: number) {
    const p = this.mePos
    const forward = new THREE.Vector3().subVectors(this.v.copy(p), this.camera.position).normalize()
    const right = new THREE.Vector3().crossVectors(forward, this.up).normalize()
    const dir = right.multiplyScalar(sx).addScaledVector(this.up, sy)
    dir.addScaledVector(p, -dir.dot(p))
    return dir.normalize()
  }
}

function fract(x: number) {
  return x - Math.floor(x)
}

function atmosphere() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#8f5bff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; varying vec3 vN; varying vec3 vV;
      void main() { float i = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(color, i * 0.7); }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  return new THREE.Mesh(new THREE.SphereGeometry(1.12, 64, 40), mat)
}
