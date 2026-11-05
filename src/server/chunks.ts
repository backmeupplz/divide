// Tiles grouped into coarse cells ("chunks") so a client is sent only the changes near it. A client keeps
// a version per chunk; a chunk coming into view whose version moved on is resent whole.

import { nearestFrom, type Planet } from '../shared/planet'

export type Chunks = { of: Uint16Array; start: Uint32Array; tiles: Uint32Array }

const chunkCache = new Map<string, Chunks>()

export function chunksOf(pl: Planet, cells: Planet): Chunks {
  const key = `${pl.subdiv}/${cells.subdiv}`
  let c = chunkCache.get(key)
  if (c) return c
  const of = new Uint16Array(pl.count)
  let hint = 0
  for (let t = 0; t < pl.count; t++) {
    hint = nearestFrom(cells, hint, pl.pos[t * 3], pl.pos[t * 3 + 1], pl.pos[t * 3 + 2])
    of[t] = hint
  }
  const start = new Uint32Array(cells.count + 1)
  for (let t = 0; t < pl.count; t++) start[of[t] + 1]++
  for (let i = 0; i < cells.count; i++) start[i + 1] += start[i]
  const fillAt = start.slice(0, cells.count)
  const tiles = new Uint32Array(pl.count)
  for (let t = 0; t < pl.count; t++) tiles[fillAt[of[t]]++] = t
  c = { of, start, tiles }
  chunkCache.set(key, c)
  return c
}

/** the planets small enough that a client sees all of it */
export const tileViewAngle = (subdiv: number) => (subdiv <= 20 ? Math.PI : 1.3)

const viewCache = new Map<string, number[][]>()

/** for every cell, the cells whose tiles a client in it is kept up to date on */
export function viewCells(cells: Planet, angle: number): number[][] {
  const key = `${cells.subdiv}/${angle}`
  let v = viewCache.get(key)
  if (v) return v
  // a cell's tiles reach about one cell spacing past its center
  const cos = Math.cos(Math.min(Math.PI, angle + cells.spacing))
  v = []
  for (let i = 0; i < cells.count; i++) {
    const list: number[] = []
    for (let j = 0; j < cells.count; j++) {
      const d = cells.pos[i * 3] * cells.pos[j * 3] + cells.pos[i * 3 + 1] * cells.pos[j * 3 + 1] + cells.pos[i * 3 + 2] * cells.pos[j * 3 + 2]
      if (d >= cos) list.push(j)
    }
    v.push(list)
  }
  viewCache.set(key, v)
  return v
}

