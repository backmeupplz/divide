import { describe, expect, test } from 'bun:test'
import { nearest, nearestFrom, planet } from '../src/shared/planet'
import { decodeSnapshot, decodeTick, encodeSnapshot, encodeTick, packTile, tileOwner, tileTrail, writeTileDiff } from '../src/shared/protocol'
import { MIN_POPULATION, ROUND_MS, Room, VIEW_ANGLE, VIEW_MAX, type Client } from '../src/server/room'
import { TICK_HZ } from '../src/shared/protocol'

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

describe('planet', () => {
  test('geodesic tile counts and neighbors', () => {
    for (const n of [1, 4, 14, 20]) {
      const p = planet(n)
      expect(p.count).toBe(10 * n * n + 2)
      let fives = 0
      for (let i = 0; i < p.count; i++) {
        const deg = p.nbrStart[i + 1] - p.nbrStart[i]
        expect(deg === 5 || deg === 6).toBe(true)
        if (deg === 5) fives++
        for (let k = p.nbrStart[i]; k < p.nbrStart[i + 1]; k++) {
          const j = p.nbr[k]
          const back = Array.from(p.nbr.subarray(p.nbrStart[j], p.nbrStart[j + 1]))
          expect(back).toContain(i)
        }
      }
      expect(fives).toBe(12)
    }
  })

  test('the largest planet still fits 16-bit tile indices', () => {
    expect(planet(64).count).toBeLessThan(65536)
  })

  test('greedy nearest matches brute force', () => {
    const p = planet(20)
    const r = rng(7)
    let hint = 0
    for (let i = 0; i < 300; i++) {
      let x = r() - 0.5, y = r() - 0.5, z = r() - 0.5
      const l = Math.hypot(x, y, z)
      x /= l
      y /= l
      z /= l
      const greedy = nearestFrom(p, hint, x, y, z)
      expect(greedy).toBe(nearest(p, x, y, z))
      hint = greedy
    }
  })
})

describe('protocol', () => {
  test('tick round trip', () => {
    const diff = new Uint8Array(30)
    let len = writeTileDiff(diff, 0, 40000, packTile(3, 2))
    len = writeTileDiff(diff, len, 7, packTile(0, 4))
    const bytes = encodeTick(123456, diff, len, [{ id: 99999, faction: 4, flags: 3, x: 0.6, y: -0.8, z: 0 }])
    const t = decodeTick(bytes)
    expect(t.tick).toBe(123456)
    expect(t.tiles).toEqual([{ idx: 40000, b: packTile(3, 2) }, { idx: 7, b: packTile(0, 4) }])
    expect(tileOwner(t.tiles[0].b)).toBe(3)
    expect(tileTrail(t.tiles[0].b)).toBe(2)
    expect(t.players[0].id).toBe(99999)
    expect(t.players[0].x).toBeCloseTo(0.6, 3)
    expect(t.players[0].y).toBeCloseTo(-0.8, 3)
  })

  test('snapshot round trip', () => {
    const s = decodeSnapshot(encodeSnapshot(14, Uint8Array.from([1, 2, 3])))
    expect(s.subdiv).toBe(14)
    expect([...s.tiles]).toEqual([1, 2, 3])
  })
})

/** a room with an empty planet, for hand-built scenarios */
function emptyRoom() {
  let now = 1_000_000
  const room = new Room('test', { now: () => now, random: rng(1) })
  const r = room as any
  for (let t = 0; t < room.planet.count; t++) r.setOwner(t, 0)
  return { room, r, advance: (ms: number) => (now += ms) }
}

function ringOnly(room: Room, c: number, radius: number) {
  const inner = new Set(room.ring(c, radius - 1))
  return room.ring(c, radius).filter((t) => !inner.has(t))
}

describe('capture', () => {
  test('closing a loop captures the inside, not the outside', () => {
    const { room, r } = emptyRoom()
    const c = 100
    const border = ringOnly(room, c, 3)
    const gap = border[0]
    for (const t of border) if (t !== gap) r.setOwner(t, 1)
    // an enemy tile and an enemy trail inside the loop
    const inside = room.ring(c, 2)
    r.setOwner(inside[3], 2)
    const p = room.addPlayer('me', 1, null)
    const enemy = room.addPlayer('them', 2, null)
    enemy.alive = true
    room.enter(enemy, inside[5])
    expect(room.trail[inside[5]]).toBe(enemy.id)
    // walk out over the gap (leaving a trail) and back onto our border
    p.alive = true
    room.enter(p, gap)
    expect(room.trail[gap]).toBe(p.id)
    room.enter(p, border[1])
    expect(room.counts[0]).toBe(room.ring(c, 3).length)
    expect(room.counts[1]).toBe(0)
    for (const t of inside) expect(room.owner[t]).toBe(1)
    expect(room.trail[gap]).toBe(0)
    expect(enemy.alive).toBe(false)
    expect(p.cuts).toBe(1)
    expect(p.captured).toBe(19 + 1)
    expect(room.recount()).toEqual(room.counts)
  })

  test('an enemy crossing a trail cuts it', () => {
    const { room, r } = emptyRoom()
    for (const t of room.ring(0, 2)) r.setOwner(t, 1)
    const p = room.addPlayer('me', 1, null)
    const q = room.addPlayer('them', 2, null)
    const out = ringOnly(room, 0, 4)
    room.enter(p, out[0])
    room.enter(p, out[1])
    expect(p.trail.length).toBe(2)
    room.enter(q, out[1])
    expect(p.alive).toBe(false)
    expect(p.trail.length).toBe(0)
    expect(room.trail[out[0]]).toBe(0)
    // the cutter's own trail now starts there
    expect(room.trail[out[1]]).toBe(q.id)
    expect(q.cuts).toBe(1)
  })

  test('teammates do not cut each other', () => {
    const { room, r } = emptyRoom()
    for (const t of room.ring(0, 2)) r.setOwner(t, 1)
    const p = room.addPlayer('a', 1, null)
    const q = room.addPlayer('b', 1, null)
    const out = ringOnly(room, 0, 4)
    room.enter(p, out[0])
    room.enter(q, out[0])
    expect(p.alive).toBe(true)
    expect(room.trail[out[0]]).toBe(p.id)
  })
})

describe('room', () => {
  test('bots play whole rounds and the bookkeeping stays consistent', () => {
    let now = 5_000_000
    const battles: any[] = []
    const sent: (string | Uint8Array)[] = []
    const client: Client = { send: (d) => void sent.push(d), buffered: () => 0 }
    const room = new Room('world', { now: () => now, random: rng(42), onBattle: (b) => battles.push(b) })
    room.addPlayer('human', 0, client)
    room.fillBots()
    expect(room.players.size).toBe(MIN_POPULATION)
    const ticks = Math.ceil((ROUND_MS / 1000) * TICK_HZ) + 40
    let captured = 0
    for (let i = 0; i < ticks; i++) {
      now += 1000 / TICK_HZ
      room.step()
      if (i % 200 === 0) {
        expect(room.recount()).toEqual(room.counts)
        for (let t = 0; t < room.planet.count; t++) {
          const id = room.trail[t]
          if (!id) continue
          const p = room.players.get(id)!
          expect(p.alive).toBe(true)
          expect(p.trail).toContain(t)
          expect(room.owner[t]).not.toBe(p.faction)
        }
      }
      captured = Math.max(captured, ...[...room.players.values()].map((p) => p.captured))
    }
    expect(captured).toBeGreaterThan(10)
    expect(battles.length).toBe(1)
    const b = battles[0]
    expect(b.counts.reduce((a: number, c: number) => a + c, 0)).toBeLessThanOrEqual(b.tiles)
    expect(b.counts[b.winner - 1]).toBe(Math.max(...b.counts))
    expect(room.phase).toBe('end')
    // the human got binary ticks, scores and the result
    expect(sent.some((d) => d instanceof Uint8Array && d[0] === 1)).toBe(true)
    expect(sent.some((d) => typeof d === 'string' && d.includes('"t":"score"'))).toBe(true)
    expect(sent.some((d) => typeof d === 'string' && d.includes('"t":"end"'))).toBe(true)
    // after the intermission a new round starts
    now += 13_000
    room.step()
    expect(room.phase).toBe('play')
  })

  test('joining humans replace bots and auto-balance', () => {
    const room = new Room('world', { random: rng(3) })
    room.fillBots()
    for (let i = 0; i < 8; i++) room.addPlayer(`h${i}`, 0, null)
    expect(room.players.size).toBe(MIN_POPULATION)
    const humans = [...room.players.values()].filter((p) => !p.bot)
    const per = [0, 0]
    for (const h of humans) per[h.faction - 1]++
    expect(Math.max(...per) - Math.min(...per)).toBeLessThanOrEqual(1)
  })

  test('crowds: each client hears about at most VIEW_MAX nearby players, itself included', () => {
    const room = new Room('big', { random: rng(9) })
    const sent: Uint8Array[] = []
    const me = room.addPlayer('me', 1, { send: (d) => void (d instanceof Uint8Array && d[0] === 1 && sent.push(d)), buffered: () => 0 })
    for (let i = 0; i < 600; i++) room.addPlayer(`p${i}`, 0, null)
    room.step()
    const t = decodeTick(sent.at(-1)!)
    expect(t.players.length).toBeLessThanOrEqual(VIEW_MAX)
    expect(t.players.length).toBeGreaterThan(10)
    expect(t.players.some((p) => p.id === me.id)).toBe(true)
    for (const p of t.players) expect(p.x * me.x + p.y * me.y + p.z * me.z).toBeGreaterThan(Math.cos(VIEW_ANGLE) - 0.01)
    // nobody nearer than the farthest one sent was left out
    const farthest = Math.min(...t.players.map((p) => p.x * me.x + p.y * me.y + p.z * me.z))
    const ids = new Set(t.players.map((p) => p.id))
    const missed = [...room.players.values()].filter((p) => !ids.has(p.id) && p.x * me.x + p.y * me.y + p.z * me.z > farthest + 0.02)
    expect(missed.length).toBe(0)
  })
})
