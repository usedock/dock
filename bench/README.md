# Dock bench

An open harness that measures sandbox providers on the same scenarios and always reports success rate and tails (P95, P99) next to the median. Run it on your own hardware against your own Dock.

## Method

The method matches ComputeSDK's sandbox benchmarks: 100 iterations per scenario, run from a 4 vCPU client, with the clock stopping at the first successful `exec('true')`.

- **Percentiles** use the nearest-rank method: sort the successful latencies ascending, take the value at rank `ceil(p/100 * n)`.
- **Success rate** is successes over all iterations. A failed iteration counts against it and is excluded from the latency percentiles. It is never dropped: every failure is listed with its error message in the table output and in the JSON.
- Every sandbox the run creates is destroyed afterwards, including when an iteration fails and on Ctrl-C. Anything that cannot be destroyed is listed under `cleanupFailures` and makes the command exit non-zero.
- Competitor adapters run at the provider's default size unless the SDK exposes it (Vercel takes the vCPU count). Compare like with like and read the numbers with that in mind.

## Scenarios

| Scenario | What the clock covers |
|---|---|
| `burst` | N concurrent creates (`--concurrency`, default 100); each clock runs from create to the first successful `exec('true')` |
| `sequential` | The same measurement, one create at a time |
| `exec` | `exec('true')` round trip on one ready sandbox, `--iterations` times |
| `resume` | Stop a ready sandbox, then time resume to the first successful `exec('true')` (concurrency applies) |
| `branch-3`, `branch-10` | From a ready source, time branching to 3 or 10 copies until every copy answers `exec('true')` |

`--scenario all` (the default) runs all of them; `--scenario branch` runs both branch scenarios. A scenario a provider cannot do is shown as skipped, not as a failure.

## Run against a self-hosted Dock

You need a running control plane with at least one ready host (see `documentation/content/docs/self-hosting.mdx`) and an API key.

```sh
cd bench
bun install
export DOCK_API_URL=https://dock.example.com   # base URL, without /v1
export DOCK_API_KEY=dock_...
bun run bench --provider dock --scenario burst --iterations 100 --concurrency 100
```

The workspace is the first one the key can see; set `DOCK_WORKSPACE_ID` to pick another. Docks are created at the default size (2 vCPU, 4 GiB, 20 GiB) and named `bench-...`. The Dock runtime (`microvm` or `gvisor`) is read from the created docks. The control plane does not report its version yet, so the version stays empty unless `/v1/health` returns one.

Each run writes `results/<date>-<provider>.json` and prints a Markdown table. Same-day runs of the same provider overwrite each other, so use `--scenario all` or the `--out` directory flag to keep them apart.

Flags: `--provider`, `--scenario`, `--iterations` (default 100), `--concurrency` (default 100, used by `burst` and `resume`), `--out` (default `results`).

## Other providers

An adapter runs only when its credentials are set; otherwise the CLI prints which variables are missing and exits 0. The vendors' official JavaScript SDKs are optional dependencies, loaded on first use.

| Provider | Environment | Notes |
|---|---|---|
| `e2b` | `E2B_API_KEY` | stop is `pause`, resume is `connect`, branch is a snapshot plus N creates |
| `vercel` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | stop and resume use persistent sandboxes, branch is a snapshot plus N creates |
| `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Sandboxes have no stop and resume, so `resume` is reported as skipped; branch uses a filesystem snapshot |

Results from different providers are comparable only when run from the same client in the same region.

## Add a provider

1. Implement the `Provider` interface from `src/providers/types.ts` (`create`, `exec`, `stop`, `resume`, `branch`, `destroy`, `info`). Set `supports` to false for what the vendor cannot do and throw `UnsupportedError` from those methods.
2. Keep the adapter thin and import the vendor SDK lazily inside methods.
3. Register it in `src/providers/index.ts` with the environment variables it requires.
4. Add a spec next to it; `src/providers/dock.spec.ts` shows the pattern with a fake HTTP server.

## Develop

```sh
bun install
bunx tsc --noEmit
bunx vitest run
```
