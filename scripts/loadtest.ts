// Fills one match with simulated players that steer randomly, then reports what they received and how long
// the server's ticks take. Usage: bun scripts/loadtest.ts [url=http://localhost:3000] [players=300] [seconds=30] [room]
// Without a room it creates a private lobby (the server only accepts rooms it issued, plus "world").
export {}

const [url = 'http://localhost:3000', playersArg = '300', secondsArg = '30', roomArg] = process.argv.slice(2)
const room = roomArg ?? ((await (await fetch(`${url}/api/lobby`, { method: 'POST' })).json()) as { id: string }).id
const players = Number(playersArg)
const seconds = Number(secondsArg)
const wsUrl = `${url.replace(/^http/, 'ws')}/ws?room=${room}`

let open = 0, closed = 0, ticks = 0, bytes = 0, welcomes = 0
const sockets: WebSocket[] = []
for (let i = 0; i < players; i++) {
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    open++
    ws.send(JSON.stringify({ t: 'join', name: `load${i}` }))
  }
  ws.onclose = () => closed++
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      bytes += e.data.length
      if (e.data.startsWith('{"t":"welcome"')) welcomes++
    } else {
      bytes += (e.data as ArrayBuffer).byteLength
      if (new Uint8Array(e.data as ArrayBuffer)[0] === 1) ticks++
    }
  }
  sockets.push(ws)
  if (i % 50 === 49) await Bun.sleep(100)
}

const steer = setInterval(() => {
  for (const ws of sockets) {
    if (ws.readyState !== WebSocket.OPEN || Math.random() > 0.3) continue
    ws.send(JSON.stringify({ t: 'dir', x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 }))
  }
}, 200)

const t0 = Date.now()
let maxTick = 0
while (Date.now() - t0 < seconds * 1000) {
  await Bun.sleep(2000)
  const s = (await (await fetch(`${url}/api/stats`)).json()) as { players: number; maxTickMs: number }
  maxTick = Math.max(maxTick, s.maxTickMs)
  const el = (Date.now() - t0) / 1000
  console.log(`${el.toFixed(0)}s open=${open} joined=${welcomes} closed=${closed} server players=${s.players} tick=${s.maxTickMs}ms ticks/client/s=${(ticks / Math.max(1, welcomes) / el).toFixed(1)} kB/client/s=${(bytes / 1024 / Math.max(1, welcomes) / el).toFixed(1)}`)
}
clearInterval(steer)
for (const ws of sockets) ws.close()
console.log(`done: ${welcomes}/${players} joined, worst average tick ${maxTick}ms (budget ${(1000 / 15).toFixed(0)}ms)`)
process.exit(welcomes === players && closed === 0 ? 0 : 1)
