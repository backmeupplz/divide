// One match: a planet, its players and bots, and the round clock. The server owns the whole simulation;
// clients only send the direction they want to go.

import { FACTION_COUNT } from '../shared/factions'
import { enclosedRegions, scratch, type Scratch } from './enclose'
import { chunksOf, tileViewAngle, viewCells } from './chunks'
import { nearest, nearestFrom, planet, subdivFor, type Planet } from '../shared/planet'
import {
  FLAG_ALIVE,
  FLAG_BOT,
  FLAG_TRAIL,
  TICK_HZ,
  encodeSnapshot,
  encodeTick,
  packTile,
  writeTileDiff,
  type Battle,
  type PlayerView,
  type ServerMsg,
  type Standing,
} from '../shared/protocol'

export const ROUND_MS = 4 * 60 * 1000
export const INTERMISSION_MS = 12 * 1000
export const RESPAWN_MS = 2500
/** tiles per second */
export const SPEED = 5
/** radians per second */
export const TURN_RATE = 5.5
/** rooms keep at least this many players, filling the gap with bots */
export const MIN_POPULATION = 12
/** players a client gets full updates about: everyone within this angle of it, nearest first */
export const VIEW_ANGLE = 0.95
export const VIEW_MAX = 96
/** coarse cells for the area-of-interest search; tile changes are sent per cell too (see chunks.ts) */
export const AOI_CELLS = planet(8)

export type Client = {
  send(data: string | Uint8Array): void
  /** bytes queued on the socket; clients that fall behind skip ticks and get a fresh snapshot */
  buffered(): number
}

export type Player = {
  id: number
  name: string
  faction: number
  bot: boolean
  client: Client | null
  x: number
  y: number
  z: number
  hx: number
  hy: number
  hz: number
  dx: number
  dy: number
  dz: number
  tile: number
  alive: boolean
  respawnAt: number
  trail: number[]
  captured: number
  cuts: number
  deaths: number
  /** names of players this client has been told about */
  known: Set<number>
  needsSnapshot: boolean
  brain: Brain | null
  /** coarse AOI cell, see flush() */
  cell: number
  /** per cell, the version of its tiles this client has */
  seen: Uint32Array
}

type Brain = { phase: 'home' | 'out' | 'turn' | 'back'; left: number; turn: number; homeTile: number; nextThink: number }

const BOT_NAMES = [
  'forky', 'validator', 'hubby', 'gossip', 'shard', 'nonce', 'mempool', 'relay', 'castooor', 'frametime',
  'warpie', 'degen', 'fid404', 'zkzk', 'snapper', 'orientee', 'quorum', 'merkle', 'signer', 'onchainer',
]

export type RoomEvents = {
  onBattle?: (b: Battle) => void
  now?: () => number
  random?: () => number
}

export class Room {
  readonly id: string
  planet!: Planet
  /** owner faction per tile */
  owner!: Uint8Array
  /** id of the player whose trail is on the tile, 0 = none */
  trail!: Uint32Array
  counts = new Array(FACTION_COUNT).fill(0)
  players = new Map<number, Player>()
  phase: 'play' | 'end' = 'play'
  endsAt = 0
  tick = 0
  lastHuman: number
  tickMs = 0
  private nextId = 1
  private dirty!: Uint8Array
  private dirtyList: number[] = []
  private diff!: Uint8Array
  /** each tile's network byte, kept current in flush() */
  private packed!: Uint8Array
  private stamp!: Uint32Array
  private epoch = 0
  private fill!: Scratch
  /** per cell: tile version, the version before this tick, the tick it last changed and that tick's tiles */
  private chunkVer = new Uint32Array(AOI_CELLS.count)
  private chunkPrev = new Uint32Array(AOI_CELLS.count)
  private chunkTick = new Int32Array(AOI_CELLS.count).fill(-1)
  private chunkDirty: number[][] = Array.from({ length: AOI_CELLS.count }, () => [])
  private buckets: number[][] = Array.from({ length: AOI_CELLS.count }, () => [])
  private cellStamp = new Uint32Array(AOI_CELLS.count)
  private cellEpoch = 0
  private ev: RoomEvents
  private now: () => number
  private rnd: () => number

  constructor(id: string, ev: RoomEvents = {}) {
    this.id = id
    this.ev = ev
    this.now = ev.now ?? Date.now
    this.rnd = ev.random ?? Math.random
    this.lastHuman = this.now()
    this.startRound()
  }

  get humans() {
    let n = 0
    for (const p of this.players.values()) if (!p.bot) n++
    return n
  }

  // ---- rounds ----

  startRound() {
    const subdiv = subdivFor(Math.max(this.players.size, MIN_POPULATION))
    this.planet = planet(subdiv)
    const n = this.planet.count
    this.owner = new Uint8Array(n)
    this.trail = new Uint32Array(n)
    this.dirty = new Uint8Array(n)
    this.dirtyList = []
    this.diff = new Uint8Array(n * 3)
    this.packed = new Uint8Array(n)
    this.stamp = new Uint32Array(n)
    this.fill = scratch(n)
    this.chunkVer.fill(1)
    this.chunkTick.fill(-1)
    this.counts.fill(0)
    this.phase = 'play'
    this.endsAt = this.now() + ROUND_MS
    // the two sides start on opposite poles
    const corners = [
      [1, 1, 1], [-1, -1, -1],
    ]
    const radius = Math.max(2, Math.round(subdiv / 5))
    for (let f = 1; f <= FACTION_COUNT; f++) {
      const [x, y, z] = corners[f - 1].map((c) => c / Math.sqrt(3))
      for (const t of this.ring(nearest(this.planet, x, y, z), radius)) this.setOwner(t, f)
    }
    this.dirtyList = []
    this.dirty.fill(0)
    this.packed.set(this.owner)
    for (const p of this.players.values()) {
      p.trail = []
      p.captured = p.cuts = p.deaths = 0
      p.tile = 0
      this.spawn(p)
      p.needsSnapshot = true
    }
    this.broadcast({ t: 'round', phase: 'play', subdiv, endsAt: this.endsAt, now: this.now() })
  }

  endRound() {
    this.phase = 'end'
    const total = this.planet.count
    let winner = 1
    for (let f = 2; f <= FACTION_COUNT; f++) if (this.counts[f - 1] > this.counts[winner - 1]) winner = f
    const ranked = this.ranked()
    const battle: Battle = {
      id: randomId(10, this.rnd),
      room: this.id,
      endedAt: this.now(),
      durationS: Math.round(ROUND_MS / 1000),
      players: this.players.size,
      tiles: total,
      counts: [...this.counts],
      winner,
      top: ranked.slice(0, 10).map(standing),
    }
    this.ev.onBattle?.(battle)
    const nextAt = this.now() + INTERMISSION_MS
    this.endsAt = nextAt
    for (const p of this.players.values()) {
      if (!p.client) continue
      p.client.send(JSON.stringify({ t: 'end', battle, me: this.me(p, ranked), nextAt, now: this.now() } satisfies ServerMsg))
    }
    return battle
  }

  /** rooms only run while people play; one that sat idle past its round's end starts a fresh round */
  wake() {
    if (this.now() >= this.endsAt) this.startRound()
  }

  // ---- players ----

  addPlayer(name: string, faction: number, client: Client | null, bot = false): Player {
    const id = this.nextId++
    if (!(faction >= 1 && faction <= FACTION_COUNT)) faction = this.smallestFaction()
    const p: Player = {
      id, name, faction, bot, client,
      x: 0, y: 0, z: 1, hx: 1, hy: 0, hz: 0, dx: 1, dy: 0, dz: 0,
      tile: 0, alive: false, respawnAt: 0, trail: [],
      captured: 0, cuts: 0, deaths: 0,
      known: new Set(), needsSnapshot: true,
      brain: bot ? { phase: 'home', left: 0, turn: 1, homeTile: 0, nextThink: 0 } : null,
      cell: 0,
      seen: new Uint32Array(client ? AOI_CELLS.count : 0),
    }
    this.players.set(id, p)
    if (!bot) {
      this.lastHuman = this.now()
      this.trimBots(faction)
    }
    this.spawn(p)
    return p
  }

  removePlayer(id: number) {
    const p = this.players.get(id)
    if (!p) return
    this.clearTrail(p)
    this.players.delete(id)
    if (!p.bot) this.lastHuman = this.now()
  }

  /** points a player toward a world direction; it turns there gradually */
  steer(p: Player, x: number, y: number, z: number) {
    const l = Math.hypot(x, y, z)
    if (!(l > 1e-6) || !Number.isFinite(l)) return
    p.dx = x / l
    p.dy = y / l
    p.dz = z / l
  }

  smallestFaction() {
    const sizes = new Array(FACTION_COUNT).fill(0)
    for (const p of this.players.values()) sizes[p.faction - 1] += p.bot ? 0.5 : 1
    let best = 0
    for (let f = 1; f < FACTION_COUNT; f++) if (sizes[f] < sizes[best] || (sizes[f] === sizes[best] && this.rnd() < 0.5)) best = f
    return best + 1
  }

  /** keeps the room at MIN_POPULATION with bots, balancing the factions */
  fillBots() {
    while (this.players.size < MIN_POPULATION) {
      const name = `bot-${BOT_NAMES[Math.floor(this.rnd() * BOT_NAMES.length)]}`
      this.addPlayer(name, this.smallestFaction(), null, true)
    }
  }

  private trimBots(preferFaction: number) {
    while (this.players.size > MIN_POPULATION) {
      let victim: Player | undefined
      for (const p of this.players.values()) {
        if (!p.bot) continue
        if (!victim || (p.faction === preferFaction && victim.faction !== preferFaction)) victim = p
      }
      if (!victim) return
      this.removePlayer(victim.id)
    }
  }

  private spawn(p: Player) {
    const pl = this.planet
    let tile = -1
    if (this.counts[p.faction - 1] > 0) {
      for (let tries = 0; tries < 300 && tile < 0; tries++) {
        const t = Math.floor(this.rnd() * pl.count)
        if (this.owner[t] === p.faction && this.trail[t] === 0) tile = t
      }
      if (tile < 0) for (let t = 0; t < pl.count && tile < 0; t++) if (this.owner[t] === p.faction) tile = t
    }
    if (tile < 0) {
      // the faction lost everything: drop it a small foothold somewhere
      tile = Math.floor(this.rnd() * pl.count)
      for (const t of this.ring(tile, 1)) {
        if (this.trail[t]) this.kill(this.players.get(this.trail[t]), null)
        this.setOwner(t, p.faction)
      }
    }
    p.tile = tile
    p.x = pl.pos[tile * 3]
    p.y = pl.pos[tile * 3 + 1]
    p.z = pl.pos[tile * 3 + 2]
    // any tangent direction
    let [hx, hy, hz] = cross(p.x, p.y, p.z, this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5)
    const l = Math.hypot(hx, hy, hz) || 1
    hx /= l
    hy /= l
    hz /= l
    p.hx = p.dx = hx
    p.hy = p.dy = hy
    p.hz = p.dz = hz
    p.trail = []
    p.alive = true
    if (p.brain) {
      p.brain.phase = 'home'
      p.brain.nextThink = 0
    }
  }

  // ---- simulation ----

  step() {
    const t0 = performance.now()
    const now = this.now()
    this.tick++
    if (this.phase === 'end') {
      if (now >= this.endsAt) this.startRound()
      else this.flush()
      return
    }
    if (now >= this.endsAt) {
      this.endRound()
      this.flush()
      return
    }
    const dt = 1 / TICK_HZ
    const pl = this.planet
    const stepAngle = SPEED * pl.spacing * dt
    const maxTurn = TURN_RATE * dt
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt) this.spawn(p)
        continue
      }
      if (p.brain) this.think(p)
      // desired direction projected onto the tangent plane
      const dp = p.dx * p.x + p.dy * p.y + p.dz * p.z
      let tx = p.dx - dp * p.x, ty = p.dy - dp * p.y, tz = p.dz - dp * p.z
      const tl = Math.hypot(tx, ty, tz)
      if (tl > 1e-6) {
        tx /= tl
        ty /= tl
        tz /= tl
        // rotate the heading toward it around the normal, at most maxTurn
        const cosA = Math.max(-1, Math.min(1, p.hx * tx + p.hy * ty + p.hz * tz))
        const [cx, cy, cz] = cross(p.hx, p.hy, p.hz, tx, ty, tz)
        const sign = cx * p.x + cy * p.y + cz * p.z >= 0 ? 1 : -1
        const a = Math.min(Math.acos(cosA), maxTurn) * sign
        // h' = h cos a + (n × h) sin a
        const [bx, by, bz] = cross(p.x, p.y, p.z, p.hx, p.hy, p.hz)
        const c = Math.cos(a), s = Math.sin(a)
        p.hx = p.hx * c + bx * s
        p.hy = p.hy * c + by * s
        p.hz = p.hz * c + bz * s
      }
      // move along the great circle
      const c = Math.cos(stepAngle), s = Math.sin(stepAngle)
      const nx = p.x * c + p.hx * s, ny = p.y * c + p.hy * s, nz = p.z * c + p.hz * s
      const hx = p.hx * c - p.x * s, hy = p.hy * c - p.y * s, hz = p.hz * c - p.z * s
      const nl = Math.hypot(nx, ny, nz)
      p.x = nx / nl
      p.y = ny / nl
      p.z = nz / nl
      // keep the heading tangent and unit length
      const hd = hx * p.x + hy * p.y + hz * p.z
      const ax = hx - hd * p.x, ay = hy - hd * p.y, az = hz - hd * p.z
      const al = Math.hypot(ax, ay, az) || 1
      p.hx = ax / al
      p.hy = ay / al
      p.hz = az / al
      const tile = nearestFrom(pl, p.tile, p.x, p.y, p.z)
      if (tile !== p.tile) {
        p.tile = tile
        this.enter(p, tile)
      }
    }
    this.flush()
    this.tickMs = this.tickMs * 0.95 + (performance.now() - t0) * 0.05
  }

  /** a player stepped onto a tile */
  enter(p: Player, tile: number) {
    const onTrail = this.trail[tile]
    if (onTrail && onTrail !== p.id) {
      const victim = this.players.get(onTrail)
      if (victim && victim.faction !== p.faction) this.kill(victim, p)
    }
    if (!p.alive) return
    if (this.owner[tile] === p.faction) {
      if (p.trail.length) this.capture(p)
      if (p.brain) p.brain.homeTile = tile
      return
    }
    if (this.trail[tile] === 0) {
      this.trail[tile] = p.id
      p.trail.push(tile)
      this.mark(tile)
    }
  }

  kill(victim: Player | undefined, killer: Player | null) {
    if (!victim || !victim.alive) return
    this.clearTrail(victim)
    victim.alive = false
    victim.deaths++
    victim.respawnAt = this.now() + RESPAWN_MS
    victim.client?.send(JSON.stringify({ t: 'event', kind: 'died', who: killer?.name } satisfies ServerMsg))
    if (killer) {
      killer.cuts++
      killer.client?.send(JSON.stringify({ t: 'event', kind: 'cut', who: victim.name } satisfies ServerMsg))
    }
  }

  private clearTrail(p: Player) {
    for (const t of p.trail) {
      if (this.trail[t] === p.id) {
        this.trail[t] = 0
        this.mark(t)
      }
    }
    p.trail = []
  }

  /** the player came home: its trail and everything it fenced off becomes its faction's */
  capture(p: Player) {
    const f = p.faction
    const before = this.counts[f - 1]
    const seeds: number[] = []
    for (const t of p.trail) {
      if (this.trail[t] !== p.id) continue
      this.trail[t] = 0
      this.setOwner(t, f)
      seeds.push(t)
    }
    p.trail = []
    for (const region of enclosedRegions(this.planet, this.owner, f, seeds, this.fill)) {
      for (const t of region) {
        const tr = this.trail[t]
        if (tr) {
          const other = this.players.get(tr)
          if (other && other.faction !== f) this.kill(other, p)
          else if (this.trail[t]) {
            this.trail[t] = 0
            this.mark(t)
          }
        }
        this.setOwner(t, f)
      }
    }
    const gained = this.counts[f - 1] - before
    p.captured += gained
    if (gained > 0) p.client?.send(JSON.stringify({ t: 'event', kind: 'captured', n: gained } satisfies ServerMsg))
    return gained
  }

  private setOwner(t: number, f: number) {
    const old = this.owner[t]
    if (old === f) return
    if (old) this.counts[old - 1]--
    if (f) this.counts[f - 1]++
    this.owner[t] = f
    this.mark(t)
  }

  private mark(t: number) {
    if (!this.dirty[t]) {
      this.dirty[t] = 1
      this.dirtyList.push(t)
    }
  }

  /** tiles within `r` steps of `t` */
  ring(t: number, r: number) {
    const pl = this.planet
    const mark = ++this.epoch
    const out = [t]
    this.stamp[t] = mark
    let frontier = [t]
    for (let d = 0; d < r; d++) {
      const next: number[] = []
      for (const a of frontier) {
        for (let k = pl.nbrStart[a]; k < pl.nbrStart[a + 1]; k++) {
          const b = pl.nbr[k]
          if (this.stamp[b] === mark) continue
          this.stamp[b] = mark
          next.push(b)
          out.push(b)
        }
      }
      frontier = next
    }
    return out
  }

  // ---- bots ----

  private think(p: Player) {
    const b = p.brain!
    if (this.tick < b.nextThink) return
    b.nextThink = this.tick + 3
    const pl = this.planet
    const home = this.owner[p.tile] === p.faction
    if (home && p.trail.length === 0) {
      if (b.phase !== 'home') {
        b.phase = 'home'
        b.left = 4 + Math.floor(this.rnd() * 10)
      }
      // wander inside, then head out in a random direction
      if (--b.left <= 0) {
        b.phase = 'out'
        b.left = 4 + Math.floor(this.rnd() * (6 + pl.subdiv / 3))
        b.turn = this.rnd() < 0.5 ? 1 : -1
        b.homeTile = p.tile
        const [x, y, z] = cross(p.x, p.y, p.z, this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5)
        this.steer(p, x, y, z)
      }
      return
    }
    if (b.phase === 'home') {
      b.phase = 'out'
      b.left = 4 + Math.floor(this.rnd() * 8)
    }
    const danger = p.trail.length > 30 + pl.subdiv
    if (b.phase === 'out' || b.phase === 'turn') {
      if (--b.left <= 0 || danger) {
        if (b.phase === 'out' && !danger) {
          // turn 90 degrees
          b.phase = 'turn'
          b.left = 3 + Math.floor(this.rnd() * (4 + pl.subdiv / 4))
          const [x, y, z] = cross(p.x, p.y, p.z, p.hx, p.hy, p.hz)
          this.steer(p, x * b.turn, y * b.turn, z * b.turn)
        } else b.phase = 'back'
      }
    }
    if (b.phase === 'back') {
      const h = b.homeTile
      this.steer(p, pl.pos[h * 3] - p.x, pl.pos[h * 3 + 1] - p.y, pl.pos[h * 3 + 2] - p.z)
      if (this.owner[b.homeTile] !== p.faction) {
        // home was taken: aim for any of our tiles nearby
        const t = this.ownTileNear(p)
        if (t >= 0) b.homeTile = t
      }
    }
  }

  private ownTileNear(p: Player) {
    for (const t of this.ring(p.tile, 12)) if (this.owner[t] === p.faction) return t
    return -1
  }

  // ---- networking ----

  /** sends this tick's changes to every client */
  private flush() {
    const chunks = chunksOf(this.planet, AOI_CELLS)
    for (const t of this.dirtyList) {
      const tr = this.trail[t]
      this.packed[t] = packTile(this.owner[t], tr ? (this.players.get(tr)?.faction ?? 0) : 0)
      this.dirty[t] = 0
      const c = chunks.of[t]
      if (this.chunkTick[c] !== this.tick) {
        this.chunkTick[c] = this.tick
        this.chunkPrev[c] = this.chunkVer[c]
        this.chunkVer[c]++
        this.chunkDirty[c].length = 0
      }
      this.chunkDirty[c].push(t)
    }
    this.dirtyList = []
    const view = viewCells(AOI_CELLS, tileViewAngle(this.planet.subdiv))
    const views: PlayerView[] = []
    const list = [...this.players.values()]
    for (const p of list) {
      views.push({
        id: p.id,
        faction: p.faction,
        flags: (p.alive ? FLAG_ALIVE : 0) | (p.trail.length ? FLAG_TRAIL : 0) | (p.bot ? FLAG_BOT : 0),
        x: p.x,
        y: p.y,
        z: p.z,
      })
    }
    // Area of interest: players are bucketed into coarse cells; each client searches the cells around it
    // ring by ring until it has enough players or leaves its view, so crowded matches cost about
    // VIEW_MAX per client instead of the whole room.
    const cells = AOI_CELLS
    const buckets = this.buckets
    for (const b of buckets) b.length = 0
    for (let j = 0; j < list.length; j++) {
      const p = list[j]
      p.cell = nearestFrom(cells, p.cell, p.x, p.y, p.z)
      buckets[p.cell].push(j)
    }
    const cosView = Math.cos(VIEW_ANGLE)
    const maxRings = Math.ceil(VIEW_ANGLE / cells.spacing) + 1
    for (let i = 0; i < list.length; i++) {
      const me = list[i]
      const c = me.client
      if (!c) continue
      if (c.buffered() > 512 * 1024) {
        me.needsSnapshot = true
        continue
      }
      if (me.needsSnapshot) {
        c.send(this.snapshot())
        me.seen.set(this.chunkVer)
        me.needsSnapshot = false
      }
      // tile changes in the chunks around the client; chunks it missed changes in are resent whole
      let len = 0
      for (const ch of view[me.cell]) {
        const v = this.chunkVer[ch]
        if (me.seen[ch] === v) continue
        if (this.chunkTick[ch] === this.tick && me.seen[ch] === this.chunkPrev[ch]) {
          for (const t of this.chunkDirty[ch]) len = writeTileDiff(this.diff, len, t, this.packed[t])
        } else {
          for (let k = chunks.start[ch]; k < chunks.start[ch + 1]; k++) {
            const t = chunks.tiles[k]
            len = writeTileDiff(this.diff, len, t, this.packed[t])
          }
        }
        me.seen[ch] = v
      }
      let near: { v: PlayerView; d: number }[] = []
      const mark = ++this.cellEpoch
      let frontier = [me.cell]
      this.cellStamp[me.cell] = mark
      for (let ring = 0; frontier.length && ring <= maxRings; ring++) {
        const next: number[] = []
        for (const cell of frontier) {
          for (const j of buckets[cell]) {
            const o = list[j]
            const d = o.x * me.x + o.y * me.y + o.z * me.z
            if (j === i || d >= cosView) near.push({ v: views[j], d: j === i ? 2 : d })
          }
          for (let k = cells.nbrStart[cell]; k < cells.nbrStart[cell + 1]; k++) {
            const n = cells.nbr[k]
            if (this.cellStamp[n] === mark) continue
            this.cellStamp[n] = mark
            next.push(n)
          }
        }
        frontier = next
        // stop with a margin past VIEW_MAX: ring order only roughly follows distance
        if (near.length > VIEW_MAX * 1.5) break
      }
      if (near.length > VIEW_MAX) near = topByD(near, VIEW_MAX)
      const fresh: [number, string, number][] = []
      for (const n of near) {
        if (me.known.has(n.v.id)) continue
        const o = this.players.get(n.v.id)!
        me.known.add(o.id)
        fresh.push([o.id, o.name, o.faction])
      }
      if (fresh.length) c.send(JSON.stringify({ t: 'names', p: fresh } satisfies ServerMsg))
      if (me.known.size > 4 * VIEW_MAX) {
        // forget players that left so the set stays small; they are re-announced if they come back into view
        for (const id of me.known) if (!this.players.has(id)) me.known.delete(id)
      }
      c.send(encodeTick(this.tick, this.diff, len, near.map((n) => n.v)))
    }
    if (this.tick % TICK_HZ === 0) this.sendScores()
  }

  /** the whole planet; flush() keeps `packed` current, so call it after flush's tile pass */
  snapshot() {
    return encodeSnapshot(this.planet.subdiv, this.packed)
  }

  private ranked() {
    return [...this.players.values()].sort((a, b) => b.captured - a.captured || b.cuts - a.cuts || a.id - b.id)
  }

  private me(p: Player, ranked: Player[]) {
    return { captured: p.captured, cuts: p.cuts, deaths: p.deaths, rank: ranked.indexOf(p) + 1 }
  }

  factionSizes() {
    const sizes = new Array(FACTION_COUNT).fill(0)
    for (const p of this.players.values()) sizes[p.faction - 1]++
    return sizes
  }

  private sendScores() {
    const ranked = this.ranked()
    const base = {
      t: 'score' as const,
      counts: this.counts,
      total: this.planet.count,
      players: this.factionSizes(),
      endsAt: this.endsAt,
      now: this.now(),
      top: ranked.slice(0, 5).map(standing),
    }
    const prefix = JSON.stringify(base).slice(0, -1)
    ranked.forEach((p, i) => {
      if (!p.client) return
      p.client.send(`${prefix},"me":${JSON.stringify({ captured: p.captured, cuts: p.cuts, deaths: p.deaths, rank: i + 1 })}}`)
    })
  }

  broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg)
    for (const p of this.players.values()) p.client?.send(s)
  }

  /** a recount, for tests: the incremental counts must always match it */
  recount() {
    const c = new Array(FACTION_COUNT).fill(0)
    for (let t = 0; t < this.planet.count; t++) if (this.owner[t]) c[this.owner[t] - 1]++
    return c
  }
}

/** the k entries with the largest d, in no particular order (quickselect, O(n)) */
export function topByD<T extends { d: number }>(a: T[], k: number): T[] {
  let lo = 0, hi = a.length - 1
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1].d
    let i = lo, j = hi
    while (i <= j) {
      while (a[i].d > pivot) i++
      while (a[j].d < pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (k - 1 <= j) hi = j
    else if (k - 1 >= i) lo = i
    else break
  }
  return a.slice(0, k)
}

function standing(p: Player): Standing {
  return { name: p.name, faction: p.faction, captured: p.captured, cuts: p.cuts }
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]
}

export function randomId(len: number, rnd: () => number = Math.random) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < len; i++) s += abc[Math.floor(rnd() * abc.length)]
  return s
}
