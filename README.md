# Dock

Isolated Linux machines for agents. On your laptop, your servers, or our cloud.

A dock is a Linux machine with a persistent disk, a stable ID and an optional name. You create it, run commands in it, stop it (the disk stays, compute is released), resume it with the same files, and branch it into copies. Each dock runs in a Firecracker microVM or a gVisor sandbox, chosen by the host it lands on.

This repo is the open core: the control plane API, the dashboard, the self-host deploy and the documentation. Dock Cloud is coming soon; self-hosting is free.

> **Status:** pre-release. Interfaces may change until the first public release; from then on `/v1` only grows. The `dock` CLI and the SDKs are not built yet.

## Layout

| Path | What it is |
| --- | --- |
| `apps/backend` | Control plane API (NestJS): docks, snapshots, branches, connectors, hosts, API keys, the outbound-only fleet API |
| `apps/dashboard` | Web dashboard (Next.js) |
| `deploy/self-host` | One-command self-hosted control plane with Docker Compose |
| `documentation` | Docs site (Fumadocs, hand-written pages) |

Docks run on hosts driven by the [docklet](https://github.com/usedock/docklet), a separate repo. The marketing site is [usedock/website](https://github.com/usedock/website).

## Concepts

| Term | Meaning |
| --- | --- |
| Dock | An isolated Linux machine with a persistent disk |
| Image | The disk a dock starts from: `ubuntu-24.04` (the only image today) or a dock you saved |
| Size | `cpus`, `memoryMiB`, `diskGiB` as numbers (default 2 vCPU, 4096 MiB, 20 GiB) |
| Runtime | `microvm` or `gvisor`, chosen by the host |
| Snapshot, Branch | A saved disk, and new docks started from it |
| Connector | An integration that lets agents in a dock work in another tool (GitHub first), with credentials kept outside the dock |
| Host | A machine that runs docks and dials out to the control plane |
| Context | Where commands go: local, cloud, or a self-hosted URL |

## Self-host

Requirements: Docker with Compose v2. To run docks on the same machine, Linux with Docker (gVisor) or `/dev/kvm` (Firecracker), and a checkout of [usedock/docklet](https://github.com/usedock/docklet) next to this repo (`../docklet`, or set `DOCKLET_DIR`).

```sh
git clone https://github.com/usedock/dock
git clone https://github.com/usedock/docklet   # only needed for --host
cd dock/deploy/self-host
./setup.sh --host                           # local: http://localhost:8088, docks on this machine
./setup.sh --url https://dock.example.com   # public instance, automatic HTTPS
```

`setup.sh` writes `.env` with fresh secrets, starts Postgres, Redis, Restate, MinIO, the API, the dashboard and Caddy on one origin, and waits until the API is healthy. `--host` also enrolls the machine as a host. More hosts join with one command each; see the [docklet](https://github.com/usedock/docklet) repo and `deploy/self-host/README.md`.

## Planned CLI

The `dock` CLI and the SDKs are not built yet. They will talk to any control plane: your own, or Dock Cloud (coming soon). The commands below are a proposal, not a working interface.

```sh
dock login --url https://dock.example.com
dock new api --cpus 4 --memory 8gb
dock exec api -- bun test
dock stop api
dock branch api --count 3
```

| Client (planned) | Repo |
| --- | --- |
| `dock` CLI | [usedock/docklet](https://github.com/usedock/docklet) |
| TypeScript SDK | [usedock/dock-js](https://github.com/usedock/dock-js) |
| Python SDK | [usedock/dock-python](https://github.com/usedock/dock-python) |
| Go SDK | [usedock/dock-go](https://github.com/usedock/dock-go) |

## Development

Each app runs on its own; there is no root workspace. Bun is the package manager.

```sh
# API
cd apps/backend
bun install
docker compose -f docker-compose.dev.yml up db redis mailpit
bun run start:dev
bun run test

# dashboard
cd apps/dashboard && bun install && bun run dev

# docs
cd documentation && bun install && bun run dev
```

CI (`.github/workflows/ci.yml`) builds and tests the backend, lints and builds the dashboard, typechecks and builds the docs, and scans for secrets.

Every behavior change ships with colocated `*.spec.ts` tests. An API change lands in the same pull request as its doc page and links the matching SDK pull requests.

## Contributing

Contributions are welcome. Every contributor signs the CLA (contributor license agreement); the CLA bot asks on your first pull request in each repository. See `CONTRIBUTING.md`.

## Security

Report vulnerabilities to [security@usedock.io](mailto:security@usedock.io), not in public issues. See `SECURITY.md`.

## License

[AGPL-3.0-only](LICENSE). Third-party agent skills under `.agents/` keep their own licenses; see `.agents/THIRD_PARTY_NOTICES.md`.

Copyright (C) 2026 Paranjay.
