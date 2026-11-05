import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/server/db'
import { start } from '../src/server/index'
import type { ServerMsg } from '../src/shared/protocol'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'divide-res-'))
  const dist = join(dir, 'dist')
  mkdirSync(dist)
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><!--divide-meta--></head><body></body></html>')
  return { dist, dataDir: join(dir, 'data') }
}

const until = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await Bun.sleep(20)
  return f()
}

function join_(port: number, room: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?room=${room}`)
  ws.binaryType = 'arraybuffer'
  const c = { ws, msgs: [] as ServerMsg[], ticks: 0, code: 0 }
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: 'x' }))
  ws.onmessage = (e) => (typeof e.data === 'string' ? c.msgs.push(JSON.parse(e.data)) : c.ticks++)
  ws.onclose = (e) => (c.code = e.code)
  return c
}

const png = async (port: number, path: string) => Buffer.from(await (await fetch(`http://localhost:${port}${path}`)).arrayBuffer())

test('issued lobbies survive a restart on the same data dir', async () => {
  const o = setup()
  const a = start({ port: 0, ...o })
  const { id } = (await (await fetch(`http://localhost:${a.server.port}/api/lobby`, { method: 'POST' })).json()) as { id: string }
  a.stop()

  const b = start({ port: 0, ...o })
  const port = b.server.port!
  const c = join_(port, id)
  expect(await until(() => c.msgs.some((m) => m.t === 'welcome'))).toBe(true)
  expect(c.code).toBe(0)
  // the lobby still gets its own share image, not the default one
  expect((await png(port, `/og/lobby/${id}.png`)).equals(await png(port, '/og/default.png'))).toBe(false)
  c.ws.close()
  b.stop()
})

test('a failing battle save or a broken room never stops the other matches', async () => {
  const o = setup()
  const real = openStore(o.dataDir)
  const store = { ...real, saveBattle: () => { throw new Error('SQLITE_BUSY') } }
  const s = start({ port: 0, ...o, store })
  const port = s.server.port!
  const lobby = async () => ((await (await fetch(`http://localhost:${port}/api/lobby`, { method: 'POST' })).json()) as { id: string }).id
  const [x, y] = [join_(port, await lobby()), join_(port, await lobby())]
  expect(await until(() => x.ticks > 2 && y.ticks > 2)).toBe(true)

  // the round result still reaches players when the save fails
  const roomX = [...s.rooms.values()].find((r) => r.id !== 'world' && r.humans && r.id === (x.msgs.find((m) => m.t === 'welcome') as { room: string }).room)!
  roomX.endRound()
  expect(await until(() => x.msgs.some((m) => m.t === 'end'))).toBe(true)

  // a room whose tick throws is logged; the other room keeps ticking
  roomX.step = () => { throw new Error('boom') }
  const before = y.ticks
  expect(await until(() => y.ticks > before + 5)).toBe(true)
  x.ws.close()
  y.ws.close()
  s.stop()
})
