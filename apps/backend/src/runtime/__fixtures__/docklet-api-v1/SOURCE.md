# Source

Copied verbatim from `usedock/docklet` `api/v1/testdata/` at commit
`51fc790f268c04bfbe914c6498ad61d941ffb7ca` (branch `feat/egress-allowlist-any-dock`,
usedock/docklet#47, which adds `egressAllow` to `snapshot-load-request.json`).
Re-point this to the merged commit on `main` once that PR lands.

Refresh by copying the folder again and updating this commit. The docklet repo
owns the files; `docklet.contract.spec.ts` checks the client types and fleet
DTOs against them, and CI typechecks that spec with `tsconfig.contract.json`.
