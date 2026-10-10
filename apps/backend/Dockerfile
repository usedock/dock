# Production image for the Dock backend API (NestJS + Drizzle, Bun runtime).
# Build/run from apps/backend via docker-compose.prod.yml (backend service).
# Migrations run separately: `docker compose -f docker-compose.prod.yml run --rm migrate`.

FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . ./
RUN bun run build

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY --from=build /app/dist ./dist

RUN addgroup -S dock && adduser -S dock -G dock
USER dock
EXPOSE 8000 2222

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8000/v1/health >/dev/null || exit 1

CMD ["bun", "dist/main"]
