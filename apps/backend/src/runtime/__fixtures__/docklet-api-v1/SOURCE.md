# Source

Copied verbatim from `usedock/docklet` `api/v1/testdata/` at commit
`8dd49f6f822e811c0415a59bee4620a98ce0428a` (branch `feat/egress-allowlist-any-dock`,
usedock/docklet#47, which adds `egressAllow` to `snapshot-load-request.json` and `features` to `fleet-register-request.json`).
Re-point this to the merged commit on `main` once that PR lands.

Refresh by copying the folder again and updating this commit. The docklet repo
owns the files; `docklet.contract.spec.ts` checks the client types and fleet
DTOs against them, and CI typechecks that spec with `tsconfig.contract.json`.
