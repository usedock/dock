# Source

Copied verbatim from `usedock/docklet` `api/v1/testdata/` at commit
`607f302a268131494491b9c01b72618a8b24f61c` (main after usedock/docklet#47).

`snapshot-create-request-full.json` and `snapshot-create-response-full.json`
are copied verbatim from the open usedock/docklet#75 (branch
`feat/full-snapshots`, commit `798e3549e8fa20776d11f6a4142287eccfb8ec29`) for
the full-snapshot contract of usedock/dock#120; refresh them from main once that
PR merges.

Refresh by copying the folder again and updating this commit. The docklet repo
owns the files; `docklet.contract.spec.ts` checks the client types and fleet
DTOs against them, and CI typechecks that spec with `tsconfig.contract.json`.
