# The Network Divide

**The Network Divide** is a live multiplayer territory war about the Farcaster split. Pick a side, Quilibrium's resistance or the Network School occupation, and fight over a small hex planet hanging over a rainy, neon-lit street, in your browser or as a Farcaster mini app.

Play at **https://divide.borodutch.com**.

## How it plays

Each player is a glowing node on a planet made of hex tiles. While you are inside your faction's territory you are safe. When you leave it, you draw a trail behind you, and when you get back home the trail and everything it fenced off becomes your faction's land, including enemy tiles caught inside. An enemy who crosses your trail cuts it and sends you back to respawn, so long trips are greedy and risky.

Rounds last four minutes. As the clock runs down, the planet cracks open along the borders between factions, and when time is up the side holding more of the planet wins. The round ends with a result card you can cast, and the next round starts twelve seconds later.

- **No player cap.** Anyone can join a match, and the planet grows with the crowd (from 1,962 tiles up to 40,962). Bots fill quiet matches up to twelve players so there is always a fight.
- **Balanced sides.** Pick a faction yourself or let the game put you on the smallest one.
- **Private lobbies.** Create a lobby, cast the invite, and everyone who opens it lands in the same match. A lobby nobody joins expires after 30 minutes, and one whose match has gone quiet stays joinable for six hours; after that its link says the lobby has ended. Only the big war and lobbies the server issued can be joined, and each address can create six lobbies a minute.
- **Sharing.** Cast your result ("I captured 12.4% of the network for Quilibrium") or a lobby invite. Both links unfurl as mini app embeds with a live image of the battle or lobby.
- **Controls.** Drag anywhere on a touch screen (a joystick appears under your finger), point with the mouse, or use WASD or the arrow keys. Pinch or scroll to zoom.

## The factions

| Faction | Role | Emblem and color | Line |
| --- | --- | --- | --- |
| Quilibrium | The resistance | round Q, magenta with an orange tail | Fully decentralized. Mostly vibes, all math. |
| Network School | The occupation | NS hex badge, violet | New management. Please report to orientation. |

## The look

The art direction is a rainy street at dusk: the resistance's worn apartment block, Q flag, barricades and burning barrel on one side, and Network School's glass HQ with searchlights, banners, a surveillance screen and a checkpoint on the other. The title is "The Network Divide" in an orange gradient with a pink "The", and the menu uses glowing cyan text. In the game the tiles are wet asphalt catching pink and violet neon, the far side of the planet fades into haze, rain falls over everything, and the cracks between territories glow hotter as the round runs down.

All of it is plain SVG in `src/shared/keyart.ts` and `src/shared/factions.ts` (the emblems), so the menu draws it in the browser and the share images draw the same scene on the server.

## How it works

The server owns the whole simulation. Clients only send the direction they want to go, and the server runs the match at 15 ticks per second.

- **Planet.** A geodesic sphere (a subdivided icosahedron) whose vertices are the tiles, so the grid is hexagons with twelve pentagons. Server and client build it from the same code, so tile numbers agree without being sent. See `src/shared/planet.ts`.
- **Captures.** When a player gets home, flood fills start from every tile next to the new border and grow in lockstep, merging when they meet. Once only one region is still growing and it is bigger than every finished one, it is the outside and everything else is captured, so a capture costs about the size of what it encloses rather than the size of the planet (`src/server/enclose.ts`).
- **Area of interest.** Players are bucketed into 642 coarse cells. Each client searches the cells around it ring by ring and is sent at most the 96 nearest players, so a crowded match costs roughly the same per player as a quiet one.
- **Chunked tile updates.** Tile changes are grouped by the same cells. Each client keeps a version per cell and is sent only the changes in the cells around it; a cell that comes back into view after missing changes is resent whole (`src/server/chunks.ts`). Small planets, which a player sees all of, just get every change.
- **Wire format.** Per-tick state is binary: 3 bytes per tile change and 12 bytes per player (`src/shared/protocol.ts`). Clients draw players about 110 ms behind the newest state and interpolate between ticks.
- **Rendering.** three.js with one instanced mesh for all tiles and one for all players, partial buffer uploads for changed tiles, low-poly geometry and the pixel ratio capped at 1.75.

### Load

`bun scripts/bench.ts <players>` runs one match with that many connected players in a single process without the network. On the development Mac (an M-series machine that was busy with other work) it measured:

| Players in one match | Server time per tick (budget 67 ms) | Sent per player per tick |
| --- | --- | --- |
| 1,000 | 14 ms | 1.8 kB |
| 2,000 | 32 ms | 1.9 kB |
| 4,000 | 88 ms | 2.0 kB |

`bun scripts/loadtest.ts http://localhost:3000 500 30` connects real WebSocket clients that steer randomly. 500 of them in one match all joined, each received 15 ticks per second at about 20 kB/s, and the server's ticks averaged 27 ms.

One match runs in one process, so a single match tops out at a few thousand players on one core today. Splitting a match across processes (for example by planet region, with the cells above as the hand-off unit) is the next step for bigger wars.

## Farcaster mini app

- The client calls `sdk.actions.ready()` and turns off native swipe gestures so dragging steers instead of closing the app.
- Inside a Farcaster client the player signs in with Quick Auth. The server verifies the token for `divide.borodutch.com` and looks the username up by the verified FID (never trusting a name the client sends), falling back to `fid:N`; a token that fails verification plays as a guest. On the plain web everyone plays as a guest with an optional nickname.
- Results and invites use `composeCast`. Outside a Farcaster client they open the Farcaster web composer.
- `/`, `/lobby/<id>` and `/battle/<id>` carry `fc:miniapp` (and `fc:frame`) embed tags and Open Graph tags. Their images are 1200×800 PNGs drawn on the server (`/og/default.png`, `/og/lobby/<id>.png`, `/og/battle/<id>.png`), along with the 1200×630 `/og/hero.png` for the manifest, the alpha-free 1024 px `/icon.png` and `/splash.png`. They render in a worker thread so they never stall a match, made-up lobby ids get the default image, and when too many renders are queued the default image is served instead.
- The manifest is served at `/.well-known/farcaster.json`. To verify domain ownership, sign the domain in a Farcaster client's developer tools and set `FARCASTER_HEADER`, `FARCASTER_PAYLOAD` and `FARCASTER_SIGNATURE` on the server; the manifest then includes the `accountAssociation`.

## Running it

You need [Bun](https://bun.sh) 1.4.

```sh
bun install
bun run build        # builds the client into dist/
bun start            # the game on http://localhost:3000
bun run check        # typecheck and tests
```

For client work, `bun start` in one terminal and `bun run dev:client` in another gives a hot-reloading client that talks to the local server.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `PUBLIC_URL` | `https://divide.borodutch.com` | used in embeds, the manifest and Quick Auth's domain check |
| `DATA_DIR` | `./data` | where the SQLite file with battle results lives |
| `FARCASTER_HEADER`, `FARCASTER_PAYLOAD`, `FARCASTER_SIGNATURE` | unset | the manifest's account association |
| `FARCASTER_USER_API` | `https://api.farcaster.xyz/v2/user?fid=` | where verified players' usernames are looked up (the FID is appended) |

Other scripts: `bun scripts/og-preview.ts <dir>` renders every share image into a folder, and `bun scripts/bench.ts` and `bun scripts/loadtest.ts` are described above.

## Layout

```
src/shared/   planet geometry, factions and the wire protocol, used by both sides
src/server/   HTTP + WebSocket server, the match simulation, captures, chunks, share images, storage
src/client/   three.js scene, input, networking, the Farcaster glue and the UI
tests/        simulation, scaling and server tests (bun test)
scripts/      load test, benchmark, share-image preview
```

## Deployment

The production image is the `Dockerfile`, which builds the client and runs the typecheck and tests before the runtime stage. It runs on Tugport, which rebuilds on every push to `main`; battle results live on a volume at `/data`.

The code lives at https://git.borodutch.com/backmeupplz/divide and is mirrored to https://github.com/backmeupplz/divide.

## License

MIT. The bundled Inter font is under the SIL Open Font License (`src/server/fonts/OFL.txt`).
