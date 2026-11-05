// Wire format. Client → server messages are small JSON objects; the server's per-tick state is binary
// (little-endian), everything else JSON.

export const TICK_HZ = 15
/** tiles per second; the client predicts its own player with the same rules */
export const SPEED = 5
/** radians per second */
export const TURN_RATE = 5.5
export const MSG_TICK = 1
export const MSG_SNAPSHOT = 2

export const FLAG_ALIVE = 1
export const FLAG_TRAIL = 2
export const FLAG_BOT = 4

/** A tile's network byte: owner faction in bits 0-2, faction of the trail on it in bits 3-5. */
export const packTile = (owner: number, trailFaction: number) => owner | (trailFaction << 3)
export const tileOwner = (b: number) => b & 7
export const tileTrail = (b: number) => (b >> 3) & 7

export type ClientMsg =
  | { t: 'join'; name?: string; faction?: number; token?: string }
  | { t: 'dir'; x: number; y: number; z: number }

export type PlayerView = { id: number; faction: number; flags: number; x: number; y: number; z: number }

export type Tick = {
  tick: number
  tiles: { idx: number; b: number }[]
  players: PlayerView[]
}

export type Standing = { name: string; faction: number; captured: number; cuts: number }

export type Battle = {
  id: string
  room: string
  endedAt: number
  durationS: number
  players: number
  tiles: number
  /** tiles per faction, index = faction id - 1 */
  counts: number[]
  winner: number
  top: Standing[]
}

export type ServerMsg =
  | {
      t: 'welcome'
      you: number
      faction: number
      room: string
      name: string
      verified: boolean
    }
  | { t: 'round'; phase: 'play' | 'end'; subdiv: number; endsAt: number; now: number }
  | { t: 'names'; p: [id: number, name: string, faction: number][] }
  | {
      t: 'score'
      counts: number[]
      total: number
      players: number[]
      endsAt: number
      now: number
      top: Standing[]
      me: { captured: number; cuts: number; deaths: number; rank: number } | null
    }
  | { t: 'event'; kind: 'cut' | 'died' | 'captured'; n?: number; who?: string }
  | { t: 'end'; battle: Battle; me: { captured: number; cuts: number; deaths: number; rank: number } | null; nextAt: number; now: number }
  | { t: 'error'; message: string }

const POS_SCALE = 32767

/** `diff` holds `diffLen` bytes of tile changes written by writeTileDiff. */
export function encodeTick(tick: number, diff: Uint8Array, diffLen: number, players: PlayerView[]) {
  const buf = new ArrayBuffer(1 + 4 + 2 + diffLen + 2 + players.length * 12)
  const v = new DataView(buf)
  const out = new Uint8Array(buf)
  let o = 0
  v.setUint8(o, MSG_TICK)
  o += 1
  v.setUint32(o, tick, true)
  o += 4
  v.setUint16(o, diffLen / 3, true)
  o += 2
  out.set(diff.subarray(0, diffLen), o)
  o += diffLen
  v.setUint16(o, players.length, true)
  o += 2
  for (const p of players) {
    v.setUint32(o, p.id, true)
    v.setUint8(o + 4, p.faction)
    v.setUint8(o + 5, p.flags)
    v.setInt16(o + 6, Math.round(p.x * POS_SCALE), true)
    v.setInt16(o + 8, Math.round(p.y * POS_SCALE), true)
    v.setInt16(o + 10, Math.round(p.z * POS_SCALE), true)
    o += 12
  }
  return out
}

/** Appends one tile change (3 bytes) to a growing diff buffer, returning the new length. */
export function writeTileDiff(buf: Uint8Array, len: number, idx: number, b: number) {
  buf[len] = idx & 255
  buf[len + 1] = idx >> 8
  buf[len + 2] = b
  return len + 3
}

export function decodeTick(data: ArrayBuffer | Uint8Array): Tick {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 1
  const tick = v.getUint32(o, true)
  o += 4
  const nt = v.getUint16(o, true)
  o += 2
  const tiles = []
  for (let i = 0; i < nt; i++) {
    tiles.push({ idx: v.getUint16(o, true), b: v.getUint8(o + 2) })
    o += 3
  }
  const np = v.getUint16(o, true)
  o += 2
  const players: PlayerView[] = []
  for (let i = 0; i < np; i++) {
    players.push({
      id: v.getUint32(o, true),
      faction: v.getUint8(o + 4),
      flags: v.getUint8(o + 5),
      x: v.getInt16(o + 6, true) / POS_SCALE,
      y: v.getInt16(o + 8, true) / POS_SCALE,
      z: v.getInt16(o + 10, true) / POS_SCALE,
    })
    o += 12
  }
  return { tick, tiles, players }
}

export function encodeSnapshot(subdiv: number, tiles: Uint8Array) {
  const out = new Uint8Array(4 + tiles.length)
  out[0] = MSG_SNAPSHOT
  out[1] = subdiv
  out.set(tiles, 4)
  return out
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return { subdiv: bytes[1], tiles: bytes.slice(4) }
}

export const ROOM_ID = /^[a-z0-9]{4,12}$/
export const BATTLE_ID = /^[a-z0-9]{6,16}$/
