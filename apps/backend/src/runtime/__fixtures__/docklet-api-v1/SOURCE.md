# Source

Copied verbatim from `usedock/docklet` `api/v1/testdata/` at commit
`607f302a268131494491b9c01b72618a8b24f61c` (main after usedock/docklet#47).

Hand-added for the full-snapshot contract of usedock/dock#120 until
usedock/docklet#72 lands: `full` on the snapshot request
(`snapshot-export-request.json`, new) and `sha256` and `baseImage` in
`snapshot-create-response.json`. Replace both files with the docklet's copies
once that PR merges.

Refresh by copying the folder again and updating this commit. The docklet repo
owns the files; `docklet.contract.spec.ts` checks the client types and fleet
DTOs against them, and CI typechecks that spec with `tsconfig.contract.json`.
