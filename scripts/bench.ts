// Server cost without the network: one room with N connected players (their sends go nowhere).
// Usage: bun scripts/bench.ts [players=1000] [ticks=300]
import { Room } from '../src/server/room'

const players = Number(process.argv[2] ?? 1000)
const ticks = Number(process.argv[3] ?? 300)
let bytes = 0
const room = new Room('bench')
for (let i = 0; i < players; i++) {
  const p = room.addPlayer(`p${i}`, 0, { send: (d) => void (bytes += d.length), buffered: () => 0 })
  room.steer(p, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
}
// a new round sizes the planet for the crowd
room.endsAt = 0
room.step()
room.endsAt = 0
room.step()
const t0 = performance.now()
for (let i = 0; i < ticks; i++) {
  if (i % 15 === 0) for (const p of room.players.values()) if (Math.random() < 0.3) room.steer(p, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
  room.step()
}
const ms = (performance.now() - t0) / ticks
console.log(`${players} players on ${room.planet.count} tiles: ${ms.toFixed(2)} ms per tick (budget ${(1000 / 15).toFixed(0)} ms), ${(bytes / players / ticks).toFixed(0)} bytes per player per tick`)
