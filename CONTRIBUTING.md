# Contributing

Thanks for helping build Dock.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Report security problems to [security@usedock.io](mailto:security@usedock.io), never in an issue. See [SECURITY.md](SECURITY.md).
- Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement

Every contributor signs the [Dock CLA](https://github.com/usedock/dock/blob/83279d37875c012493ef59b52f91a88c63bbae94/CLA.md). Signatures are stored per repository, so the CLA bot asks on your first pull request in each repository; reply with the sentence it gives you to sign. You keep the copyright in your work.

## Development

Each app runs on its own; there is no root workspace.

```sh
cd apps/backend
bun install
cp .env.example .env   # then set SECRETS_ENCRYPTION_KEY to the output of `openssl rand -hex 32`
docker compose -f docker-compose.dev.yml up -d db redis mailpit
bun run db:migrate
bun run start:dev
bun run test        # Vitest; every behavior change ships with colocated *.spec.ts tests
bun run build       # nest build
```

The dashboard: `cd apps/dashboard && bun install && bun run lint && bun run build`. The docs: `cd documentation && bun install && bunx fumadocs-mdx && bun run typecheck && bun run build`. CI runs all of these.

An API change lands in the same pull request as its doc page under `documentation/`, and links the matching pull requests in [dock-js](https://github.com/usedock/dock-js), [dock-python](https://github.com/usedock/dock-python) and [dock-go](https://github.com/usedock/dock-go).

## Pull requests

- One change per pull request, with tests.
- Conventional commit titles: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`.
- Short comments only where the why is not obvious; no emojis in code, comments or commits.
- A maintainer reviews every pull request before merge.
