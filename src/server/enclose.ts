import type { Planet } from '../shared/planet'

export type Scratch = { stamp: Uint32Array; sid: Int32Array; epoch: number }

export function scratch(count: number): Scratch {
  return { stamp: new Uint32Array(count), sid: new Int32Array(count), epoch: 0 }
}

const BATCH = 8

/**
 * The regions a faction has just fenced off. Tiles not owned by faction `f` fall into connected regions;
 * the biggest is the outside and every other one is enclosed. A flood fill starts from each tile next to
 * the new border, all of them growing in lockstep and merging when they meet. Once only one region still
 * grows and it is already bigger than every finished (complete) one, it must be the outside and the search
 * stops: the cost is about the size of the enclosed areas, not of the planet.
 */
export function enclosedRegions(pl: Planet, owner: Uint8Array, f: number, border: number[], s: Scratch): number[][] {
  const epoch = ++s.epoch
  const { stamp, sid } = s
  const members: number[][] = []
  const head: number[] = []
  const parent: number[] = []
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (const b of border) {
    for (let k = pl.nbrStart[b]; k < pl.nbrStart[b + 1]; k++) {
      const u = pl.nbr[k]
      if (owner[u] === f || stamp[u] === epoch) continue
      const id = members.length
      stamp[u] = epoch
      sid[u] = id
      members.push([u])
      head.push(0)
      parent.push(id)
    }
  }
  if (members.length === 0) return []
  const n = members.length
  const size = new Float64Array(n)
  for (;;) {
    // Stop when nothing grows, or when one region still grows and is already bigger than every
    // finished one (so it is the biggest: the outside).
    size.fill(0)
    let activeRoot = -1
    let several = false
    for (let i = 0; i < n; i++) {
      const r = find(i)
      size[r] += members[i].length
      if (head[i] >= members[i].length) continue
      if (activeRoot < 0) activeRoot = r
      else if (r !== activeRoot) several = true
    }
    if (activeRoot < 0) break
    if (!several) {
      let biggestDone = 0
      for (let i = 0; i < n; i++) if (i !== activeRoot && parent[i] === i) biggestDone = Math.max(biggestDone, size[i])
      if (size[activeRoot] > biggestDone) break
    }
    for (let i = 0; i < n; i++) {
      const list = members[i]
      for (let b = 0; b < BATCH && head[i] < list.length; b++) {
        const t = list[head[i]++]
        for (let k = pl.nbrStart[t]; k < pl.nbrStart[t + 1]; k++) {
          const u = pl.nbr[k]
          if (owner[u] === f) continue
          if (stamp[u] !== epoch) {
            stamp[u] = epoch
            sid[u] = i
            list.push(u)
          } else {
            const a = find(i), c = find(sid[u])
            if (a !== c) parent[a] = c
          }
        }
      }
    }
  }
  // gather the regions
  const regions = new Map<number, { tiles: number[]; active: boolean }>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let g = regions.get(r)
    if (!g) regions.set(r, (g = { tiles: [], active: false }))
    for (const t of members[i]) g.tiles.push(t)
    if (head[i] < members[i].length) g.active = true
  }
  const all = [...regions.values()]
  let outside = all.findIndex((g) => g.active)
  if (outside < 0) {
    outside = 0
    for (let i = 1; i < all.length; i++) if (all[i].tiles.length > all[outside].tiles.length) outside = i
  }
  return all.filter((_, i) => i !== outside).map((g) => g.tiles)
}
