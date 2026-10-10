# Repository Guidelines

## Project Overview

Dock: isolated Linux machines for agents. On your laptop, your servers, or our cloud.

This repo is the open core (AGPL-3.0-only): the control plane API, the dashboard, the self-host deploy and the documentation. Other parts live elsewhere:

- the docklet (host agent, Go) lives in `usedock/docklet`
- the marketing site and cloud-only code live in private repos (not open to contributors)
- client SDKs and the `dock` CLI are not built yet; planned repos are `usedock/dock-js`, `dock-python`, `dock-go`

Layout (no root workspace; each app runs on its own):

- `apps/backend` — NestJS control-plane API (`@dock/backend`)
- `apps/dashboard` — Next.js dashboard (docks, snapshots, environments, runs, hosts, keys)
- `deploy/self-host` — one-command self-hosted control plane (`setup.sh`, `docker-compose.yml`, `Caddyfile`, `.env.example`, `README.md`)
- `documentation` — Fumadocs site, hand-written pages
- `.claude`, `.agents`, `skills-lock.json` — agent definitions and skills

## Product truth

- Headline: "Isolated Linux machines for agents. On your laptop, your servers, or our cloud."
- A Dock has an image (`ubuntu-24.04`, the only one today, or a saved dock), a size as numbers (`cpus`, `memoryMiB`, `diskGiB`; default 2 vCPU, 4 GB, 20 GB) and a runtime chosen by its host: `microvm` (Firecracker on KVM, whole disk persists) or `gvisor` (runsc on Docker, only `/home/user/work` persists). The runtime is read-only on the dock.
- Dock never installs or versions coding agents; users bring their own (install them in the environment setup script).
- Self-hosting is free; Dock Cloud is coming soon. The `dock` CLI and SDKs are not built yet; do not document them as working.
- Vocabulary: `Dock`, `Image`, `Size`, `Runtime`, `Environment`, `Snapshot`, `Branch`, `Host`, `Connector`, `Template`, `Run`, `Workspace`. Never `box`, `computer`, `tier`, `class`, `toolbox`.

## Working Agreements

- Backend: every behavior change ships with colocated `*.spec.ts` tests; `bun run test` green before yield. No test-less backend changes.
- An API change lands in the same PR as its hand-written docs page under `documentation/`.
- Comments: short one-liners only, and only where the why is not obvious from the code. No paragraph comments, no commented-out code.
- No emojis in code, comments, or commit text.
- Dashboard: compose UI from shadcn primitives (`components/ui/`) + Tailwind utilities only. No hand-written CSS, no `<style>` blocks, no new global stylesheets. Clean, minimal design: plain backgrounds, clean sans, one accent.
- Maintainability first: boring code, existing patterns, no new abstraction without a proven second use; delete dead code on sight.
- Never commit secrets or `.env` files (only `.env.example`).

## Architecture & Data Flow

NestJS modular monolith plus a Next.js App Router dashboard. No `turbo`/`nx`/shared `packages/`.

Backend request path:
`client → /v1/* → JwtAuthGuard (@Public() bypass; API key or Better Auth session) → ValidationPipe → controller → service → Drizzle/Postgres and/or Redis → EnvelopeInterceptor {ok:true,data} / HttpExceptionFilter {ok:false,code,message}`

- Controllers are thin (validate DTO, call service, return the raw value). Services own logic and Drizzle queries. See `apps/backend/src/api-keys/`.
- Auth: global `JwtAuthGuard` (historical name; `apps/backend/src/auth/jwt-auth.guard.ts`), opt-out via `@Public()`, user via `@CurrentUser()`. Two credentials: `Authorization: Bearer dock_...` API key (SHA-256 hash lookup), else, only when no Bearer header is sent, a Better Auth cookie session (`/api/auth/*`). No JWT access tokens.
- State: Postgres is durable; Redis is ephemeral (rate counters, tickets, hot stats).
- Runtime plane: one docklet per host connects outbound only to the control plane's fleet API (`/v1/fleet/*`): it registers, heartbeats inventory, long-polls commands and posts results. Restate (durable workflows) and MinIO (snapshot generations) run centrally on the control plane. `RUNTIME_DRIVER=fake|restate` (default `fake`). The docklet contract lives in `usedock/docklet`.
- Lifecycle is async, idempotent and reconciled (`new` → `ready` → `work` → `stop` → `resume`/`branch`).

## Development Commands

Run per app from the repo root:

| Purpose | Backend (`apps/backend`) | Dashboard (`apps/dashboard`) | Docs (`documentation`) |
|---|---|---|---|
| Install | `bun install` | `bun install` | `bun install` |
| Dev | `cp .env.example .env` (set `SECRETS_ENCRYPTION_KEY`), `docker compose -f docker-compose.dev.yml up -d db redis mailpit`, `bun run db:migrate`, then `bun run start:dev` | `bun run dev` | `bun run dev` |
| Build | `bun run build` | `bun run build` | `bun run build` |
| Test / check | `bun run test` (single: `bunx vitest run <spec>`) | `bun run lint` | `bunx fumadocs-mdx && bun run typecheck` |

Self-host: `cd deploy/self-host && ./setup.sh [--host] [--url https://dock.example.com]`. `--host` needs a `usedock/docklet` checkout at `../docklet` (or `DOCKLET_DIR`).

## Code Conventions

- NestJS triad `*.module.ts + *.controller.ts + *.service.ts`, kebab-case files, PascalCase classes. Every POST has an explicit `@HttpCode(200|201)`.
- Validation: `class-validator` DTOs; env fail-fast Zod in `apps/backend/src/config/validate-env.ts`.
- DB: Drizzle `pgTable`, snake_case columns, uuid PK, `timestamptz`, explicit `index()`. Schema change: `bun run db:generate` and commit the migration.
- Errors: Nest `HttpException` with `{code,message}`, snake_case codes.
- Security: store token and API-key hashes only; fail closed on Redis errors that gate auth or rate limits.
- Style: 2-space, single quotes, semicolons.

## Runtime/Tooling

- Bun (>=1.1) with committed `bun.lock` per app; no root workspace, no `package-lock.json`.
- NestJS 11, Drizzle, Vitest, ioredis; Next 16, React 19, Tailwind v4.

## Testing & QA

- Backend: Vitest, colocated `src/**/*.spec.ts`.
- CI (`.github/workflows/ci.yml`) runs the backend build and tests, the dashboard lint and build, the docs typecheck and build, and a gitleaks scan.
- Known baseline: backend `env-apply-script.spec.ts` fails on Windows only (argv length limit); it passes on Linux CI.
