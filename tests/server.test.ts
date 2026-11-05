import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateAddress, start } from '../src/server/index'
import { MSG_SNAPSHOT, MSG_TICK, decodeSnapshot, decodeTick, type ServerMsg } from '../src/shared/protocol'
import { planet } from '../src/shared/planet'

let srv: ReturnType<typeof start>
let base = ''
const PUBLIC = 'https://divide.example.com'

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'divide-test-'))
  const dist = join(dir, 'dist')
  mkdirSync(dist)
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>Divide</title><!--divide-meta--></head><body></body></html>')
  writeFileSync(join(dist, 'robots.txt'), 'ok')
  srv = start({ port: 0, publicUrl: PUBLIC, redirectHosts: 'old.example.com', dist, dataDir: join(dir, 'data'), verify: async (t) => (t === 'good' ? 1234 : null), lookupUser: async (fid) => (fid === 1234 ? { username: 'bob', pfp: 'https://img.example.com/bob.png' } : { username: null, pfp: null }), fetchPfp: async (u) => (u === 'https://img.example.com/bob.png' ? { bytes: new Uint8Array([137, 80, 78, 71]), type: 'image/png' } : null) })
  base = `http://localhost:${srv.server.port}`
})

afterAll(() => srv.stop())

function embedOf(html: string) {
  const m = html.match(/<meta name="fc:miniapp" content="([^"]+)">/)
  expect(m).not.toBeNull()
  const json = m![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  return JSON.parse(json)
}

describe('http', () => {
  test('manifest', async () => {
    const m = await (await fetch(`${base}/.well-known/farcaster.json`)).json()
    expect(m.miniapp.name).toBe('The Network Divide')
    expect(m.miniapp.homeUrl).toBe(PUBLIC)
    expect(m.miniapp.iconUrl).toBe(`${PUBLIC}/icon.png`)
    expect(m.miniapp.subtitle.length).toBeLessThanOrEqual(30)
    expect(m.miniapp.tagline.length).toBeLessThanOrEqual(30)
    expect(m.miniapp.description.length).toBeLessThanOrEqual(170)
    expect(m.miniapp.tags.length).toBeLessThanOrEqual(5)
    expect(m.accountAssociation).toBeUndefined()
    expect(m.miniapp.heroImageUrl).toBe(`${PUBLIC}/og/hero.png`)
  })

  test('home and lobby pages carry mini app embeds', async () => {
    const home = embedOf(await (await fetch(`${base}/`)).text())
    expect(home.version).toBe('1')
    expect(home.imageUrl).toBe(`${PUBLIC}/og/default.png`)
    expect(home.button.action.type).toBe('launch_miniapp')
    expect(home.button.title.length).toBeLessThanOrEqual(32)
    const lobby = embedOf(await (await fetch(`${base}/lobby/abcd12`)).text())
    expect(lobby.button.action.url).toBe(`${PUBLIC}/lobby/abcd12`)
    expect(lobby.imageUrl).toBe(`${PUBLIC}/og/lobby/abcd12.png`)
  })

  test('share images are 3:2 PNGs', async () => {
    for (const path of ['/og/default.png', '/og/lobby/abcd12.png', '/og/battle/nosuchbattle.png']) {
      const r = await fetch(base + path)
      expect(r.headers.get('content-type')).toBe('image/png')
      const b = new Uint8Array(await r.arrayBuffer())
      expect([...b.slice(1, 4)]).toEqual([80, 78, 71])
      const v = new DataView(b.buffer)
      expect(v.getUint32(16)).toBe(1200)
      expect(v.getUint32(20)).toBe(800)
    }
    // the mini app icon: 1024 px with no alpha channel (PNG color type 2, RGB)
    const icon = new Uint8Array(await (await fetch(`${base}/icon.png`)).arrayBuffer())
    expect(new DataView(icon.buffer).getUint32(16)).toBe(1024)
    expect(icon[25]).toBe(2)
    const hero = new DataView(await (await fetch(`${base}/og/hero.png`)).arrayBuffer())
    expect([hero.getUint32(16), hero.getUint32(20)]).toEqual([1200, 630])
    // made-up lobby ids get the default image instead of a render of their own
    const def = await (await fetch(`${base}/og/default.png`)).arrayBuffer()
    const fake = await (await fetch(`${base}/og/lobby/zz9zz9.png`)).arrayBuffer()
    expect(Buffer.from(fake).equals(Buffer.from(def))).toBe(true)
  })

  test('lobby creation is rate limited per address', async () => {
    const post = () => fetch(`${base}/api/lobby`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' } })
    const codes = []
    for (let i = 0; i < 8; i++) codes.push((await post()).status)
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200])
    expect(codes.slice(6)).toEqual([429, 429])
  })

  test('the pfp proxy refuses private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.169.254', '100.80.1.2', '0.0.0.0', '::1', 'fd7a:115c::1', '::ffff:127.0.0.1']) expect(privateAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '104.21.39.202', '2606:4700::6810:84e5']) expect(privateAddress(ip)).toBe(false)
  })

  test('the old host redirects, but keeps serving share images', async () => {
    const r = await fetch(`${base}/lobby/abcd12?x=1`, { headers: { host: 'old.example.com' }, redirect: 'manual' })
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe(`${PUBLIC}/lobby/abcd12?x=1`)
    const img = await fetch(`${base}/og/default.png`, { headers: { host: 'old.example.com' }, redirect: 'manual' })
    expect(img.status).toBe(200)
  })

  test('lobbies, static files and bad paths', async () => {
    const { id } = await (await fetch(`${base}/api/lobby`, { method: 'POST' })).json()
    expect(id).toMatch(/^[a-z0-9]{6}$/)
    expect(await (await fetch(`${base}/robots.txt`)).text()).toBe('ok')
    expect((await fetch(`${base}/../package.json`)).status).toBe(404)
    expect((await fetch(`${base}/api/battle/zzzzzzzz`)).status).toBe(404)
    for (const dir of ['/assets', '/assets/']) expect((await fetch(base + dir)).status).toBe(404)
  })
})

type Conn = { ws: WebSocket; msgs: ServerMsg[]; ticks: number; snapshot: Uint8Array | null; tilesSeen: number }

function connect(room: string, join: object): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?room=${room}`)
    ws.binaryType = 'arraybuffer'
    const c: Conn = { ws, msgs: [], ticks: 0, snapshot: null, tilesSeen: 0 }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', ...join }))
      resolve(c)
    }
    ws.onerror = reject
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') c.msgs.push(JSON.parse(e.data))
      else {
        const b = new Uint8Array(e.data as ArrayBuffer)
        if (b[0] === MSG_SNAPSHOT) c.snapshot = decodeSnapshot(b).tiles
        if (b[0] === MSG_TICK) {
          c.ticks++
          c.tilesSeen += decodeTick(b).tiles.length
        }
      }
    }
  })
}

const lobby = async () => ((await (await fetch(`${base}/api/lobby`, { method: 'POST' })).json()) as { id: string }).id

const until = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await Bun.sleep(20)
  return f()
}

describe('websocket', () => {
  test('several clients share one match', async () => {
    const id = await lobby()
    const a = await connect(id, { name: 'alice', faction: 2 })
    // a verified player is named from their FID, whatever username the client claims
    const b = await connect(id, { token: 'good', username: 'dwr' })
    const c = await connect(id, { token: 'forged', name: 'carol' })
    expect(await until(() => [a, b, c].every((x) => x.msgs.some((m) => m.t === 'welcome') && x.snapshot && x.ticks > 3))).toBe(true)
    const wa = a.msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>
    const wb = b.msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>
    const wc = c.msgs.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>
    expect(wa.faction).toBe(2)
    expect(wa.name).toBe('alice')
    expect(wb.verified).toBe(true)
    expect(wb.name).toBe('@bob')
    // a verified player's pfp comes through our own origin; nobody else's does
    expect(await until(() => b.msgs.some((m) => m.t === 'names' && m.p.some((e) => e[1] === '@bob' && e[3] === 1234)))).toBe(true)
    const pfp = await fetch(`${base}/pfp/1234`)
    expect(pfp.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await pfp.arrayBuffer())]).toEqual([137, 80, 78, 71])
    expect((await fetch(`${base}/pfp/999`)).status).toBe(404)
    // a bad token plays as a guest under its nickname
    expect(wc.verified).toBe(false)
    expect(wc.name).toBe('carol')
    const round = a.msgs.find((m) => m.t === 'round') as Extract<ServerMsg, { t: 'round' }>
    expect(a.snapshot!.length).toBe(planet(round.subdiv).count)
    const room = srv.rooms.get(id)!
    expect(room.humans).toBe(3)
    expect(room.players.size).toBe(12)
    // steering is accepted
    a.ws.send(JSON.stringify({ t: 'dir', x: 1, y: 0, z: 0 }))
    expect(await until(() => a.msgs.some((m) => m.t === 'score'), 2500)).toBe(true)
    for (const x of [a, b, c]) x.ws.close()
    expect(await until(() => room.humans === 0)).toBe(true)
    expect(room.players.size).toBe(12)
  })

  test('rejects bad rooms and floods', async () => {
    expect((await fetch(`${base}/ws?room=../x`)).status).toBe(400)
    const a = await connect(await lobby(), { name: 'f' })
    // junk frames are ignored, not fatal
    a.ws.send('null')
    a.ws.send('42')
    const closed = new Promise<number>((r) => (a.ws.onclose = (e) => r(e.code)))
    for (let i = 0; i < 200; i++) a.ws.send(JSON.stringify({ t: 'dir', x: 1, y: 0, z: 0 }))
    expect(await closed).toBe(1008)
  })

  test('refuses rooms nobody created', async () => {
    const x = await connect('madeup1', { name: 'x' })
    const code = await new Promise<number>((r) => (x.ws.onclose = (e) => r(e.code)))
    expect(code).toBe(4404)
    expect(x.msgs.some((m) => m.t === 'error')).toBe(true)
    expect(srv.rooms.has('madeup1')).toBe(false)
  })
})
