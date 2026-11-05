// The planet: a geodesic sphere (a subdivided icosahedron). Every vertex is one tile, so the tiles form a
// hex grid with 12 pentagons. Server and client build it with this same code, so tile indices agree.

export type Planet = {
  subdiv: number
  count: number
  /** unit vectors, xyz per tile */
  pos: Float64Array
  /** CSR adjacency: neighbors of tile i are nbr[nbrStart[i] .. nbrStart[i + 1]) */
  nbrStart: Uint32Array
  nbr: Uint32Array
  /** mean angle (radians) between neighboring tiles */
  spacing: number
}

const cache = new Map<number, Planet>()

export function planet(subdiv: number): Planet {
  let p = cache.get(subdiv)
  if (!p) {
    p = build(subdiv)
    cache.set(subdiv, p)
  }
  return p
}

function build(n: number): Planet {
  const t = (1 + Math.sqrt(5)) / 2
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  })
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  const index = new Map<string, number>()
  const pts: number[] = []
  const edges = new Set<number>()
  const vertex = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z)
    x /= l
    y /= l
    z /= l
    const key = `${Math.round(x * 1e7)},${Math.round(y * 1e7)},${Math.round(z * 1e7)}`
    let i = index.get(key)
    if (i === undefined) {
      i = pts.length / 3
      index.set(key, i)
      pts.push(x, y, z)
    }
    return i
  }
  const edge = (a: number, b: number) => {
    if (a === b) return
    edges.add(a < b ? a * 65536 + b : b * 65536 + a)
  }
  for (const [ia, ib, ic] of faces) {
    const A = base[ia], B = base[ib], C = base[ic]
    // grid[i][j]: i steps from A toward B, j steps from A toward C (i + j <= n)
    const grid: number[][] = []
    for (let i = 0; i <= n; i++) {
      grid.push([])
      for (let j = 0; i + j <= n; j++) {
        const a = (n - i - j) / n, b = i / n, c = j / n
        grid[i].push(vertex(A[0] * a + B[0] * b + C[0] * c, A[1] * a + B[1] * b + C[1] * c, A[2] * a + B[2] * b + C[2] * c))
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        const p = grid[i][j], q = grid[i + 1][j], r = grid[i][j + 1]
        edge(p, q)
        edge(q, r)
        edge(r, p)
      }
    }
  }
  const count = pts.length / 3
  const lists: number[][] = Array.from({ length: count }, () => [])
  for (const e of [...edges].sort((x, y) => x - y)) {
    const a = Math.floor(e / 65536), b = e % 65536
    lists[a].push(b)
    lists[b].push(a)
  }
  const nbrStart = new Uint32Array(count + 1)
  for (let i = 0; i < count; i++) nbrStart[i + 1] = nbrStart[i] + lists[i].length
  const nbr = new Uint32Array(nbrStart[count])
  let sum = 0
  for (let i = 0; i < count; i++) {
    nbr.set(lists[i], nbrStart[i])
    for (const j of lists[i]) sum += Math.acos(Math.min(1, pts[i * 3] * pts[j * 3] + pts[i * 3 + 1] * pts[j * 3 + 1] + pts[i * 3 + 2] * pts[j * 3 + 2]))
  }
  return { subdiv: n, count, pos: Float64Array.from(pts), nbrStart, nbr, spacing: sum / nbr.length }
}

export function dotTile(p: Planet, i: number, x: number, y: number, z: number) {
  return p.pos[i * 3] * x + p.pos[i * 3 + 1] * y + p.pos[i * 3 + 2] * z
}

/** Nearest tile to a unit vector, walking from a nearby tile (greedy descent works on a Delaunay mesh). */
export function nearestFrom(p: Planet, hint: number, x: number, y: number, z: number) {
  let best = hint
  let bestDot = dotTile(p, hint, x, y, z)
  for (;;) {
    let moved = false
    for (let k = p.nbrStart[best], end = p.nbrStart[best + 1]; k < end; k++) {
      const j = p.nbr[k]
      const d = dotTile(p, j, x, y, z)
      if (d > bestDot) {
        bestDot = d
        best = j
        moved = true
      }
    }
    if (!moved) return best
  }
}

export function nearest(p: Planet, x: number, y: number, z: number) {
  let best = 0
  let bestDot = -2
  for (let i = 0; i < p.count; i++) {
    const d = dotTile(p, i, x, y, z)
    if (d > bestDot) {
      bestDot = d
      best = i
    }
  }
  return best
}

/** Planet size for a round, from the number of players in the room. */
export function subdivFor(players: number) {
  if (players <= 16) return 14
  if (players <= 40) return 20
  if (players <= 120) return 30
  if (players <= 400) return 44
  return 64
}
