import { defineConfig } from 'vite'

// `bun run dev:client` serves the client with hot reload and forwards the game server's routes to
// `bun start` on :3000.
const server = 'http://localhost:3000'

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      '/ws': { target: server, ws: true },
      '/api': server,
      '/og': server,
      '/icon.png': server,
      '/splash.png': server,
      '/.well-known': server,
    },
  },
})
