# Production image for the Dock docs site (Fumadocs on Next.js standalone, Bun runtime).
# Build/run from documentation via docker-compose.prod.yml (docs service).

FROM oven/bun:1-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . ./
RUN bun run build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001
RUN addgroup -S dock && adduser -S dock -G dock
COPY --from=builder --chown=dock:dock /app/.next/standalone ./
COPY --from=builder --chown=dock:dock /app/.next/static ./.next/static
USER dock
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3001/ >/dev/null || exit 1

CMD ["bun", "server.js"]
