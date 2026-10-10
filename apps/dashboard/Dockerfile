# Production image for the Dock dashboard (Next.js standalone, Bun runtime).
# Build/run from apps/dashboard via docker-compose.prod.yml (dashboard service).

FROM oven/bun:1-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . ./
# Build-time public backend origin (inlined into the client bundle).
ARG NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL=https://api.usedock.io
ARG NEXT_PUBLIC_APP_URL=https://dashboard.usedock.io
ARG NEXT_PUBLIC_DOCS_URL=https://docs.usedock.io
ENV NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL=$NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_DOCS_URL=$NEXT_PUBLIC_DOCS_URL
RUN bun run build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3002
RUN addgroup -S dock && adduser -S dock -G dock
COPY --from=builder --chown=dock:dock /app/.next/standalone ./
COPY --from=builder --chown=dock:dock /app/.next/static ./.next/static
USER dock
EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3002/auth/login >/dev/null || exit 1

CMD ["bun", "server.js"]
