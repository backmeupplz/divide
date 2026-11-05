// Renders every share image into a folder, to look at them: bun scripts/og-preview.ts /tmp/og
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { battleSvg, defaultSvg, iconSvg, lobbySvg, render } from '../src/server/og'

const dir = process.argv[2] ?? 'og-preview'
mkdirSync(dir, { recursive: true })
const battle = {
  id: 'preview123', room: 'world', endedAt: Date.now(), durationS: 240, players: 37, tiles: 4002,
  counts: [1320, 980, 760, 512], winner: 1,
  top: [{ name: '@borodutch', faction: 1, captured: 412, cuts: 9 }],
}
const out = {
  'default.png': render(defaultSvg()),
  'battle.png': render(battleSvg(battle)),
  'lobby.png': render(lobbySvg('k3x9qa', [5, 3, 4, 2])),
  'lobby-empty.png': render(lobbySvg('k3x9qa', null)),
  'icon.png': render(iconSvg()),
}
for (const [name, png] of Object.entries(out)) writeFileSync(join(dir, name), png)
console.log(`wrote ${Object.keys(out).length} images to ${dir}`)
