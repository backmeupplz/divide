import * as THREE from 'three'
import { FACTIONS } from '../shared/factions'
import { planet, type Planet } from '../shared/planet'
import { FLAG_ALIVE, SPEED, TICK_HZ, TURN_RATE, tileOwner, tileTrail, type PlayerView } from '../shared/protocol'

const MAX_PLAYERS = 128
/** other players are drawn this far behind the newest server state, so their motion stays smooth */
const INTERP_MS = 120
const TICK_MS = 1000 / TICK_HZ
/** the territory floats just above the Earth's surface */
const CELL_R = 1.004

const factionColor = FACTIONS.map((f) => new THREE.Color(f.color))
const HOT = new THREE.Color('#ff8a2a')

type Sample = { t: number; players: Map<number, PlayerView> }

/** the two Earth maps, loaded once; `progress` reports 0..1 for the loading screen */
export function loadEarth(progress: (p: number) => void) {
  const manager = new THREE.LoadingManager()
  manager.onProgress = (_url, done, total) => progress(done / total)
  const loader = new THREE.TextureLoader(manager)
  const get = (url: string) =>
    new Promise<THREE.Texture>((resolve) =>
      loader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace
          t.anisotropy = 4
          resolve(t)
        },
        undefined,
        // a missing map still leaves a playable dark globe
        () => resolve(new THREE.Texture()),
      ),
    )
  return Promise.all([get('/earth/day.jpg'), get('/earth/lights.jpg')])
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
  planet: Planet | null = null
  tiles: Uint8Array = new Uint8Array(0)
  /** 0 at round start, 1 at its end: how wide the cracks along the front lines are */
  crack = 0
  zoom = 1
  me = 0
  /** the menu's slowly turning globe */
  attract = false
  /** where the player wants to go (a world direction), for predicting our own motion */
  want: THREE.Vector3 | null = null
  private earthMat: THREE.ShaderMaterial
  private cells: THREE.Mesh | null = null
  private cellColor: THREE.BufferAttribute | null = null
  private cellShrink: THREE.BufferAttribute | null = null
  /** first vertex of each tile's cell and its vertex count */
  private cellStart = new Uint32Array(0)
  private border = new Uint8Array(0)
  private appliedCrack = -1
  private dirtyAll = false
  private dirtyMin = Infinity
  private dirtyMax = -1
  /** players as round avatars facing the camera: the Farcaster pfp when there is one */
  private sprites: THREE.Sprite[] = []
  private avatars = new Map<string, THREE.SpriteMaterial>()
  /** name, side and pfp FID of a player, from the server's names messages */
  who: (id: number) => { name: string; pfp: number } | undefined = () => undefined
  private halo: THREE.Mesh
  // remote players: samples on the server's tick clock, played back by a clock that follows them smoothly
  private samples: Sample[] = []
  private playT = -1
  private lastFrame = performance.now()
  // our own player, predicted from the input and pulled toward what the server says
  private pred = { on: false, pos: new THREE.Vector3(), head: new THREE.Vector3(), lastServer: new THREE.Vector3(), alive: false, faction: 0, err: new THREE.Vector3(), headTo: new THREE.Vector3() }
  private up = new THREE.Vector3(0, 1, 0)
  private mePos = new THREE.Vector3(0, 0, 1)
  /** interpolated positions this frame, for labels */
  readonly drawn = new Map<number, { pos: THREE.Vector3; faction: number; alive: boolean }>()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3()
  private yAxis = new THREE.Vector3(0, 1, 0)
  // adaptive resolution: drop the pixel ratio when frames run slow, raise it again when there's room
  private maxDpr = Math.min(window.devicePixelRatio || 1, 2)
  private dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  private slowFor = 0
  private fastFor = 0
  private frameAvg = 16
  private size = { w: 1, h: 1 }

  constructor(canvas: HTMLCanvasElement, maps: THREE.Texture[] = []) {
    // transparent, so the rainy dusk sky drawn behind the canvas shows through
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: (window.devicePixelRatio || 1) < 2, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setClearColor(0x000000, 0)
    this.scene.add(this.camera)

    this.earthMat = earthMaterial(maps[0] ?? null, maps[1] ?? null)
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), this.earthMat))
    this.scene.add(atmosphere())

    this.halo = new THREE.Mesh(new THREE.TorusGeometry(1, 0.1, 6, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 }))
    this.halo.visible = false
    this.scene.add(this.halo)
  }

  setMaps(maps: THREE.Texture[]) {
    this.earthMat.uniforms.day.value = maps[0]
    this.earthMat.uniforms.lights.value = maps[1]
    this.earthMat.uniforms.hasMaps.value = 1
  }

  resize(w: number, h: number) {
    this.size = { w, h }
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** the pixel ratio in use, for the debug overlay */
  get pixelRatio() {
    return this.dpr
  }

  setPlanet(subdiv: number, tiles: Uint8Array) {
    const pl = planet(subdiv)
    if (this.planet !== pl) {
      if (this.cells) {
        this.scene.remove(this.cells)
        this.cells.geometry.dispose()
      }
      this.planet = pl
      this.buildCells(pl)
    }
    this.tiles = tiles.slice()
    for (let i = 0; i < pl.count; i++) this.border[i] = this.isBorder(i) ? 1 : 0
    this.appliedCrack = this.crackStep()
    for (let i = 0; i < pl.count; i++) this.drawTile(i)
    this.dirtyAll = true
  }

  /** each tile is its own flat cell (5 or 6 corners) on a single mesh; colors and gaps change per tile */
  private buildCells(pl: Planet) {
    const centers: number[] = []
    const corners: number[] = []
    const edge: number[] = []
    const index: number[] = []
    this.cellStart = new Uint32Array(pl.count + 1)
    this.border = new Uint8Array(pl.count)
    const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3()
    let vert = 0
    for (let i = 0; i < pl.count; i++) {
      p.set(pl.pos[i * 3], pl.pos[i * 3 + 1], pl.pos[i * 3 + 2])
      // neighbors sorted by angle around the tile
      t1.set(Math.abs(p.x) < 0.9 ? 1 : 0, Math.abs(p.x) < 0.9 ? 0 : 1, 0).cross(p).normalize()
      t2.crossVectors(p, t1)
      const ns: { j: number; ang: number }[] = []
      for (let k = pl.nbrStart[i]; k < pl.nbrStart[i + 1]; k++) {
        const j = pl.nbr[k]
        a.set(pl.pos[j * 3], pl.pos[j * 3 + 1], pl.pos[j * 3 + 2]).sub(p)
        ns.push({ j, ang: Math.atan2(a.dot(t2), a.dot(t1)) })
      }
      ns.sort((x, y) => x.ang - y.ang)
      this.cellStart[i] = vert
      centers.push(p.x, p.y, p.z)
      corners.push(p.x, p.y, p.z)
      edge.push(0)
      const first = vert
      vert++
      for (let k = 0; k < ns.length; k++) {
        const j1 = ns[k].j, j2 = ns[(k + 1) % ns.length].j
        a.set(pl.pos[j1 * 3], pl.pos[j1 * 3 + 1], pl.pos[j1 * 3 + 2])
        b.set(pl.pos[j2 * 3], pl.pos[j2 * 3 + 1], pl.pos[j2 * 3 + 2])
        // the corner shared by this tile and two neighbors
        a.add(b).add(p).normalize()
        centers.push(p.x, p.y, p.z)
        corners.push(a.x, a.y, a.z)
        edge.push(1)
        index.push(first, first + 1 + k, first + 1 + ((k + 1) % ns.length))
        vert++
      }
    }
    this.cellStart[pl.count] = vert
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3))
    g.setAttribute('center', new THREE.Float32BufferAttribute(centers, 3))
    g.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 1))
    this.cellColor = new THREE.Uint8BufferAttribute(new Uint8Array(vert * 4), 4, true)
    this.cellColor.setUsage(THREE.DynamicDrawUsage)
    this.cellShrink = new THREE.Float32BufferAttribute(new Float32Array(vert), 1)
    this.cellShrink.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('tint', this.cellColor)
    g.setAttribute('shrink', this.cellShrink)
    g.setIndex(vert > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CELL_R)
    this.cells = new THREE.Mesh(g, cellMaterial())
    this.cells.renderOrder = 1
    this.scene.add(this.cells)
  }

  setTile(i: number, b: number) {
    const pl = this.planet
    if (!pl || i >= pl.count || this.tiles[i] === b) return
    this.tiles[i] = b
    this.drawTile(i)
    for (let k = pl.nbrStart[i]; k < pl.nbrStart[i + 1]; k++) {
      const j = pl.nbr[k]
      const was = this.border[j]
      this.border[j] = this.isBorder(j) ? 1 : 0
      if (was !== this.border[j]) this.drawTile(j)
    }
    const was = this.border[i]
    this.border[i] = this.isBorder(i) ? 1 : 0
    if (was !== this.border[i]) this.drawTile(i)
  }

  /** a tile on the front line between the two sides */
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
    const col = this.cellColor!.array as Uint8Array
    const shr = this.cellShrink!.array as Float32Array
    const b = this.tiles[i]
    const owner = tileOwner(b)
    const trail = tileTrail(b)
    const crack = this.crackStep() / 12
    let r = 0, g = 0, bl = 0, a = 0
    if (trail) {
      const c = factionColor[trail - 1]
      r = c.r * 0.6 + 0.4
      g = c.g * 0.6 + 0.4
      bl = c.b * 0.6 + 0.4
      a = 0.92
    } else if (owner) {
      const c = this.border[i] ? factionColor[owner - 1].clone().lerp(HOT, 0.25 + 0.5 * crack) : factionColor[owner - 1]
      r = c.r
      g = c.g
      bl = c.b
      a = 0.42
    }
    // front-line cells pull back as the round runs out, opening glowing cracks in the ground
    const shrink = trail ? 0.8 : this.border[i] ? 0.93 - 0.35 * crack : 0.97
    const s = this.cellStart[i], e = this.cellStart[i + 1]
    for (let v = s; v < e; v++) {
      col[v * 4] = r * 255
      col[v * 4 + 1] = g * 255
      col[v * 4 + 2] = bl * 255
      col[v * 4 + 3] = a * 255
      shr[v] = shrink
    }
    if (s < this.dirtyMin) this.dirtyMin = s
    if (e > this.dirtyMax) this.dirtyMax = e
  }

  private upload() {
    const col = this.cellColor, shr = this.cellShrink
    if (!col || !shr) return
    if (this.dirtyAll) {
      col.clearUpdateRanges()
      shr.clearUpdateRanges()
      col.needsUpdate = shr.needsUpdate = true
    } else if (this.dirtyMax > this.dirtyMin) {
      // one span covering every change this frame: cheaper than many tiny uploads
      col.clearUpdateRanges()
      shr.clearUpdateRanges()
      col.addUpdateRange(this.dirtyMin * 4, (this.dirtyMax - this.dirtyMin) * 4)
      shr.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin)
      col.needsUpdate = shr.needsUpdate = true
    }
    this.dirtyAll = false
    this.dirtyMin = Infinity
    this.dirtyMax = -1
  }

  /** called with every server tick, in arrival order */
  addTick(tick: number, players: PlayerView[]) {
    const map = new Map<number, PlayerView>()
    for (const p of players) map.set(p.id, p)
    const t = tick * TICK_MS
    if (this.samples.length && t <= this.samples[this.samples.length - 1].t) return
    this.samples.push({ t, players: map })
    if (this.samples.length > 20) this.samples.shift()
    const mine = map.get(this.me)
    if (mine) this.correct(mine)
  }

  resetTimeline() {
    this.samples = []
    this.playT = -1
    this.pred.on = false
  }

  /** the direction on the planet's surface that points "up" on screen at the player */
  get screenUp() {
    return this.up
  }

  get playerPos() {
    return this.mePos
  }

  frame() {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.adapt(dt)
    this.earthMat.uniforms.time.value = now / 1000
    const pl = this.planet
    if (!pl || !this.cells) {
      this.renderer.render(this.scene, this.camera)
      return
    }
    if (this.crackStep() !== this.appliedCrack) {
      this.appliedCrack = this.crackStep()
      for (let i = 0; i < pl.count; i++) if (this.border[i]) this.drawTile(i)
    }
    this.upload()
    this.earthMat.uniforms.heat.value = this.crack
    this.interpolate(dt)
    this.predict(dt, pl)
    if (this.attract) {
      // the whole globe, slowly turning, hanging over the street
      const portrait = this.camera.aspect < 1
      const dist = portrait ? 6.2 : 4.4
      const a = now / 30000
      this.camera.up.set(0, 1, 0)
      this.camera.position.set(Math.sin(a) * dist, dist * 0.22, Math.cos(a) * dist)
      this.camera.lookAt(0, portrait ? -1.25 : -0.5, 0)
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
    const d = Math.max(0.35, pl.spacing * 14) * this.zoom * (portrait ? 1.35 : 1)
    this.camera.position.copy(p).multiplyScalar(1 + d).addScaledVector(this.up, -d * 0.3)
    this.camera.up.copy(this.up)
    this.camera.lookAt(this.v.copy(p).addScaledVector(this.up, d * 0.1))
    this.drawPlayers(pl)
    this.renderer.render(this.scene, this.camera)
  }

  private adapt(dt: number) {
    if (dt <= 0 || dt >= 0.1) return
    this.frameAvg = this.frameAvg * 0.95 + dt * 1000 * 0.05
    if (this.frameAvg > 24) this.slowFor += dt
    else this.slowFor = 0
    if (this.frameAvg < 12) this.fastFor += dt
    else this.fastFor = 0
    if (this.slowFor > 1 && this.dpr > 0.5) {
      this.dpr = Math.max(0.5, this.dpr * 0.8)
      this.slowFor = 0
      this.frameAvg = 16
      this.resize(this.size.w, this.size.h)
    } else if (this.fastFor > 4 && this.dpr < this.maxDpr) {
      this.dpr = Math.min(this.maxDpr, this.dpr * 1.15)
      this.fastFor = 0
      this.resize(this.size.w, this.size.h)
    }
  }

  /** remote players: a playback clock that runs at real speed and leans toward INTERP_MS behind the newest tick */
  private interpolate(dt: number) {
    this.drawn.clear()
    const n = this.samples.length
    if (!n) return
    const target = this.samples[n - 1].t - INTERP_MS
    if (this.playT < 0 || Math.abs(target - this.playT) > 500) this.playT = target
    else {
      const lean = Math.max(-0.15, Math.min(0.15, (target - this.playT) * 0.003))
      this.playT += dt * 1000 * (1 + lean)
    }
    const t = this.playT
    let a = this.samples[0], b = this.samples[n - 1]
    for (let i = 0; i < n; i++) {
      if (this.samples[i].t <= t) a = this.samples[i]
      if (this.samples[i].t >= t) {
        b = this.samples[i]
        break
      }
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

  /** a new server state for our own player: start, snap or nudge the prediction */
  private correct(v: PlayerView) {
    const pr = this.pred
    const s = this.v.set(v.x, v.y, v.z)
    const alive = (v.flags & FLAG_ALIVE) !== 0
    pr.faction = v.faction
    if (!alive) {
      pr.alive = false
      return
    }
    const spacing = this.planet?.spacing ?? 0.05
    if (!pr.on || !pr.alive || pr.pos.angleTo(s) > spacing * 4) {
      // (re)spawned or far off: start from the server, heading the way it last moved
      const moved = s.clone().sub(pr.lastServer)
      if (pr.alive && moved.length() > 1e-6 && moved.length() < spacing * 2) pr.head.copy(moved)
      else if (pr.head.lengthSq() < 1e-6) pr.head.set(0, 1, 0)
      pr.pos.copy(s)
      tangent(pr.head, pr.pos)
      pr.err.set(0, 0, 0)
      pr.headTo.copy(pr.head)
      pr.on = true
    } else {
      // the server moved where we predicted, give or take the round trip: pull gently toward it,
      // leading it by about one tick so the correction doesn't drag us backwards
      const moved = s.clone().sub(pr.lastServer)
      // The correction is stored and bled in over the next frames: applied at once, 15 small jumps a
      // second jerk the camera, which follows this player.
      const lead = s.clone().addScaledVector(moved, 1.5).normalize()
      pr.err.copy(lead).sub(pr.pos).multiplyScalar(0.35)
      if (moved.lengthSq() > 1e-10) pr.headTo.copy(moved).normalize()
    }
    pr.alive = true
    pr.lastServer.copy(s)
  }

  /** our own player moves every frame by the same rules the server uses, so steering answers at once */
  private predict(dt: number, pl: Planet) {
    const pr = this.pred
    if (this.attract || !pr.on) return
    // the prediction runs on the newest state, not the interpolated past the others are drawn at
    if (!pr.alive) {
      this.drawn.delete(this.me)
      return
    }
    const want = this.want
    if (want) {
      const w = want.clone().addScaledVector(pr.pos, -want.dot(pr.pos))
      if (w.lengthSq() > 1e-8) {
        w.normalize()
        const ang = Math.acos(Math.max(-1, Math.min(1, pr.head.dot(w))))
        const turn = Math.min(ang, TURN_RATE * dt)
        const sign = this.s.crossVectors(pr.head, w).dot(pr.pos) >= 0 ? 1 : -1
        pr.head.applyAxisAngle(pr.pos, turn * sign)
      }
    }
    // ease toward the server's heading only while not steering, so turns stay crisp
    if (!want && pr.headTo.lengthSq() > 0) pr.head.lerp(pr.headTo, 1 - Math.exp(-dt * 2))
    const step = SPEED * pl.spacing * dt
    pr.pos.addScaledVector(pr.head, Math.tan(step))
    const k = 1 - Math.exp(-dt * 6)
    pr.pos.addScaledVector(pr.err, k).normalize()
    pr.err.multiplyScalar(1 - k)
    tangent(pr.head, pr.pos)
    this.drawn.set(this.me, { pos: pr.pos.clone(), faction: pr.faction, alive: true })
  }

  private drawPlayers(pl: Planet) {
    let i = 0
    const size = Math.max(0.012, pl.spacing * 0.5)
    const pulse = Math.sin(performance.now() / 150)
    this.halo.visible = false
    for (const [id, d] of this.drawn) {
      if (!d.alive || i >= MAX_PLAYERS) continue
      let sp = this.sprites[i]
      if (!sp) {
        sp = new THREE.Sprite()
        sp.renderOrder = 2
        this.sprites[i] = sp
        this.scene.add(sp)
      }
      const me = id === this.me
      sp.material = this.avatar(id, d.faction, me)
      sp.visible = true
      const r = size * (me ? 2.3 : 1.9)
      sp.position.copy(d.pos).multiplyScalar(CELL_R + r * 0.55)
      sp.scale.set(r, r, 1)
      if (me) {
        this.halo.visible = true
        this.halo.position.copy(d.pos).multiplyScalar(CELL_R + 0.002)
        this.halo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.pos)
        const h = size * (1.5 + 0.1 * pulse)
        this.halo.scale.set(h, h, h)
      }
      i++
    }
    for (; i < this.sprites.length; i++) this.sprites[i].visible = false
  }

  /** a round badge: the pfp (or the name's first letter) inside a ring in the side's color */
  private avatar(id: number, faction: number, me: boolean) {
    const info = this.who(id)
    const name = (info?.name ?? '').replace(/^(@|bot-|anon-|fid:)/, '')
    const letter = (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
    const key = `${info?.pfp ? `p${info.pfp}` : `l${letter}`}:${faction}:${me ? 1 : 0}`
    let mat = this.avatars.get(key)
    if (mat) return mat
    const S = 128
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = S
    const g = canvas.getContext('2d')!
    const color = FACTIONS[faction - 1]?.color ?? '#ffffff'
    const ring = (img?: HTMLImageElement) => {
      g.clearRect(0, 0, S, S)
      g.save()
      g.beginPath()
      g.arc(S / 2, S / 2, S / 2 - 12, 0, Math.PI * 2)
      g.clip()
      if (img) {
        // a centered square of the picture, so wide or tall pfps are cropped, never squished
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 12, 12, S - 24, S - 24)
      }
      else {
        g.fillStyle = '#140c22'
        g.fillRect(0, 0, S, S)
        g.fillStyle = color
        g.font = '800 58px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(letter, S / 2, S / 2 + 3)
      }
      g.restore()
      g.lineWidth = me ? 12 : 9
      g.strokeStyle = me ? '#ffffff' : color
      g.shadowColor = color
      g.shadowBlur = 10
      g.beginPath()
      g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2)
      g.stroke()
    }
    ring()
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    this.avatars.set(key, mat)
    if (info?.pfp) {
      const img = new Image()
      img.onload = () => {
        ring(img)
        tex.needsUpdate = true
      }
      img.src = `/pfp/${info.pfp}`
    }
    if (this.avatars.size > 400) {
      const [k, old] = this.avatars.entries().next().value!
      this.avatars.delete(k)
      old.map?.dispose()
      old.dispose()
    }
    return mat
  }

  /** screen position (CSS pixels) of a point on the planet, or null when it faces away */
  project(pos: THREE.Vector3, w: number, h: number, lift = 1.2) {
    const camDir = this.v.copy(this.camera.position).normalize()
    if (pos.dot(camDir) < 0.2) return null
    const p = pos.clone().multiplyScalar(CELL_R + (this.planet?.spacing ?? 0.05) * lift).project(this.camera)
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

/** keeps a heading tangent to the sphere at `pos`, unit length */
function tangent(h: THREE.Vector3, pos: THREE.Vector3) {
  h.addScaledVector(pos, -h.dot(pos))
  if (h.lengthSq() < 1e-10) h.set(0, 1, 0).addScaledVector(pos, -pos.y)
  h.normalize()
}

/** the Earth at dusk: the day map pushed down into night blues, city lights glowing on top */
function earthMaterial(day: THREE.Texture | null, lights: THREE.Texture | null) {
  return new THREE.ShaderMaterial({
    uniforms: {
      day: { value: day },
      lights: { value: lights },
      hasMaps: { value: day ? 1 : 0 },
      heat: { value: 0 },
      time: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D day; uniform sampler2D lights; uniform float hasMaps; uniform float heat; uniform float time;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        // (these are linear values: the output turns them into sRGB, which brightens darks a lot)
        vec3 base = vec3(0.004, 0.004, 0.014);
        if (hasMaps > 0.5) {
          vec3 d = texture2D(day, vUv).rgb;
          float lum = dot(d, vec3(0.3, 0.55, 0.15));
          // oceans sink into deep indigo, land keeps a little of its color
          // (ice and deserts are capped, so they never glare through the territory)
          base = mix(vec3(0.004, 0.007, 0.03), min(d, vec3(0.5)) * vec3(0.42, 0.38, 0.62), smoothstep(0.02, 0.12, lum));
          float l = texture2D(lights, vUv).r;
          base += vec3(1.0, 0.62, 0.32) * pow(l, 1.6) * 1.15;
        }
        // a thin glow at the edge of the disc only, so a close camera doesn't haze the whole ground
        float rim = pow(1.0 - max(dot(vN, vV), 0.0), 6.0);
        base += vec3(0.25, 0.1, 0.7) * rim * 0.5;
        // the ground under the cracks warms up as the round runs out
        base += vec3(0.5, 0.12, 0.02) * heat * 0.04;
        gl_FragColor = vec4(base, 1.0);
        #include <colorspace_fragment>
      }`,
  })
}

/** territory cells: flat, see-through, with a bright rim so the hex grid reads on the globe */
function cellMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `attribute vec3 center; attribute float edge; attribute vec4 tint; attribute float shrink;
      varying vec4 vTint; varying float vEdge;
      void main() {
        vTint = tint; vEdge = edge;
        vec3 p = normalize(mix(center, position, shrink)) * ${CELL_R.toFixed(4)};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `varying vec4 vTint; varying float vEdge;
      void main() {
        if (vTint.a < 0.01) discard;
        float rim = smoothstep(0.72, 1.0, vEdge);
        vec3 c = vTint.rgb * (0.85 + 0.6 * rim);
        gl_FragColor = vec4(c, vTint.a * (0.75 + 0.25 * rim));
      }`,
    transparent: true,
    depthWrite: false,
  })
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
  return new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 40), mat)
}
