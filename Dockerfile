# Production image (Tugport builds this file). Every FROM must use the Bun version CI pins
# (BUN_VERSION in .forgejo/workflows/ci.yml); CI fails when they differ.

# Build the client, and gate the deploy on the typecheck and the tests, on the Bun that will run them.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run typecheck && bun test

# The runtime: the server's own dependencies, its sources and the built client.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
