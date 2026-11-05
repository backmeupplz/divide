import { describe, expect, test } from 'bun:test'
import { enclosedRegions, scratch } from '../src/server/enclose'
import { AOI_CELLS, Room } from '../src/server/room'
import { chunksOf, tileViewAngle, viewCells } from '../src/server/chunks'
import { planet } from '../src/shared/planet'
import { MSG_SNAPSHOT, MSG_TICK, decodeSnapshot, decodeTick } from '../src/shared/protocol'

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

/** components of the tiles not owned by f, by plain flood fill */
function components(pl: ReturnType<typeof planet>, owner: Uint8Array, f: number) {
  const seen = new Uint8Array(pl.count)
  const out: number[][] = []
  for (let s = 0; s < pl.count; s++) {
    if (owner[s] === f || seen[s]) continue
    const c = [s]
    seen[s] = 1
    for (let i = 0; i < c.length; i++)
      for (let k = pl.nbrStart[c[i]]; k < pl.nbrStart[c[i] + 1]; k++) {
        const u = pl.nbr[k]
        if (owner[u] !== f && !seen[u]) {
          seen[u] = 1
          c.push(u)
        }
      }
    out.push(c)
  }
  return out
}

describe('enclosure search', () => {
  test('matches a brute-force flood fill: everything but the biggest region', () => {
    const pl = planet(10)
    const r = rng(11)
    const sc = scratch(pl.count)
    let checked = 0
    for (let trial = 0; trial < 300; trial++) {
      const owner = new Uint8Array(pl.count)
      // random walls: a few random walks of faction 1
      const walks = 1 + Math.floor(r() * 6)
      for (let w = 0; w < walks; w++) {
        let t = Math.floor(r() * pl.count)
        const len = 10 + Math.floor(r() * 160)
        for (let i = 0; i < len; i++) {
          owner[t] = 1
          const deg = pl.nbrStart[t + 1] - pl.nbrStart[t]
          t = pl.nbr[pl.nbrStart[t] + Math.floor(r() * deg)]
        }
      }
      for (let t = 0; t < pl.count; t++) if (!owner[t] && r() < 0.1) owner[t] = 2
      const comps = components(pl, owner, 1).sort((a, b) => b.length - a.length)
      if (comps.length > 1 && comps[0].length === comps[1].length) continue
      const border: number[] = []
      for (let t = 0; t < pl.count; t++) if (owner[t] === 1) border.push(t)
      const got = enclosedRegions(pl, owner, 1, border, sc).map((g) => g.slice().sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
      const want = comps.slice(1).map((g) => g.slice().sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
      expect(got).toEqual(want)
      checked++
    }
    expect(checked).toBeGreaterThan(200)
  })

  test('a lone big region with many seeds is not mistaken for an enclosure', () => {
    const pl = planet(12)
    const owner = new Uint8Array(pl.count)
    // a small pocket with one opening seed next to a long wall (many seeds on the big side)
    const sc = scratch(pl.count)
    for (let t = 0; t < pl.count; t++) if (pl.pos[t * 3 + 2] > 0.2 && pl.pos[t * 3 + 2] < 0.3) owner[t] = 1
    const comps = components(pl, owner, 1).sort((a, b) => b.length - a.length)
    const border: number[] = []
    for (let t = 0; t < pl.count; t++) if (owner[t] === 1) border.push(t)
    const got = enclosedRegions(pl, owner, 1, border, sc)
    expect(got.length).toBe(1)
    expect(got[0].length).toBe(comps[1].length)
  })
})

describe('chunked tile updates', () => {
  test('a client mirror matches the server everywhere it can see, on a big planet', () => {
    let now = 1e6
    const room = new Room('big', { now: () => now, random: rng(5) })
    const mirror = { tiles: new Uint8Array(0) }
    let last: Uint8Array | null = null
    const me = room.addPlayer('me', 1, {
      send(d) {
        if (!(d instanceof Uint8Array)) return
        if (d[0] === MSG_SNAPSHOT) mirror.tiles = decodeSnapshot(d).tiles
        if (d[0] === MSG_TICK) {
          for (const t of decodeTick(d).tiles) mirror.tiles[t.idx] = t.b
          last = d
        }
      },
      buffered: () => 0,
    })
    for (let i = 0; i < 300; i++) room.addPlayer(`p${i}`, 0, null, true)
    // start a round sized for the crowd
    room.endsAt = 0
    room.step()
    now += 13_000
    room.step()
    expect(room.planet.subdiv).toBeGreaterThan(20)
    const chunks = chunksOf(room.planet, AOI_CELLS)
    const view = viewCells(AOI_CELLS, tileViewAngle(room.planet.subdiv))
    const packed = (room as any).packed as Uint8Array
    for (let i = 0; i < 400; i++) {
      now += 1000 / 15
      // wander so chunks come into and out of view
      if (i % 30 === 0) room.steer(me, Math.sin(i), Math.cos(i * 0.7), Math.sin(i * 1.3))
      room.step()
      if (i % 25 !== 0) continue
      let compared = 0
      for (const ch of view[me.cell]) {
        for (let k = chunks.start[ch]; k < chunks.start[ch + 1]; k++) {
          const t = chunks.tiles[k]
          expect(mirror.tiles[t]).toBe(packed[t])
          compared++
        }
      }
      expect(compared).toBeLessThan(room.planet.count)
    }
    // the client is sent a fraction of the planet's changes
    expect(last).not.toBeNull()
  })
})

describe('topByD', () => {
  test('picks the k largest', async () => {
    const { topByD } = await import('../src/server/room')
    const r = rng(2)
    for (let n = 1; n < 300; n += 7) {
      const a = Array.from({ length: n }, () => ({ d: Math.floor(r() * 20) }))
      const k = Math.max(1, Math.floor(n / 3))
      const want = a.map((x) => x.d).sort((x, y) => y - x).slice(0, k)
      const got = topByD(a.slice(), k).map((x) => x.d).sort((x, y) => y - x)
      expect(got).toEqual(want)
    }
  })
})
