# Source

Copied verbatim from `usedock/docklet` `api/v1/testdata/` at commit
`607f302a268131494491b9c01b72618a8b24f61c` (main after usedock/docklet#47),
except `fleet-heartbeat-request-images.json`: the control plane does not accept
the heartbeat `images` field yet, so that file is left out until it does.

Refresh by copying the folder again and updating this commit. The docklet repo
owns the files; `docklet.contract.spec.ts` checks the client types and fleet
DTOs against them, and CI typechecks that spec with `tsconfig.contract.json`.
