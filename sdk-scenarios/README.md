# SDK scenarios

Language-neutral scenarios for the Dock client SDKs. Each SDK repo
(`@usedock/sdk` in `usedock/dock-js`, `usedock` in `usedock/dock-python`, the Go
module in `usedock/dock-go`) runs the same files in its own tests, so the SDKs
stay consistent with each other and with the `/v1` API.

```
ops.yaml                    op name -> HTTP method, path, body fields
scenarios/<name>.yaml       one flow per file
fixtures/<name>.json        recorded HTTP exchanges for offline runs
schema/scenario.schema.json JSON Schema for scenario files
test/                       validation spec (run in CI)
```

SDK repos vendor this directory (copy or git submodule) and pin the commit.

## Scenario format

```yaml
name: create-exec-delete          # equals the file name without .yaml
description: ...
steps:
  - id: create                    # unique in the file, kebab-case
    op: docks.create              # an op from ops.yaml
    args:                         # path parameters and body fields of the op
      workspaceId: "${workspaceId}"
      name: "sdk-${run}-ced"
      cpus: 1
    capture:                      # variable -> dot path into the response envelope
      dockId: data.id
    expect:
      status: 201
      ok: true
      code: validation_error      # failures only
      data:                       # subset match, see below
        state: ready
cleanup:                          # runs after the steps, even when one failed
  - op: docks.delete
    args:
      dockId: "${dockId}"
```

Variables are written `${name}`. Built in: `workspaceId` (from
`DOCK_WORKSPACE_ID`) and `run` (a short random string per scenario run, used to
keep dock names unique). Every `capture` adds a variable for later steps and
cleanup. A string that is exactly one variable keeps the variable's type;
otherwise the text is substituted in place.

`expect.data` is a subset match against the response envelope's `data`:
objects match when every listed key matches, arrays match element by element
and must have the same length, scalars must be equal, and the string `$any`
matches any non-null value. `status` is the HTTP status; `ok` and `code` are the
envelope fields (`{ ok: true, data }` or `{ ok: false, code, message }`).
Messages are never asserted.

## Ops

`ops.yaml` has two sections.

- `http`: a call to one route. `path` uses `{arg}` placeholders for path
  parameters; `body` lists the args sent as the JSON body (absent args are
  omitted, never sent as null); `query` lists query-string args; `headers`
  values are templates over args (`docks.delete` sends
  `x-confirm-delete: <dockId>`); `optionalHeaders` lists headers the route
  reads that a caller may add (`docks.exec` takes `idempotency-key`: a replay
  with the same key returns the first result). `status` is the status of a
  success.
- `composite`: SDK helpers with no route of their own. The API has no file
  routes, so `docks.files.write`, `docks.files.read` and `docks.files.list` are
  one `docks.exec` call with the exact `command` template in `ops.yaml`
  (`{contentBase64}` is the base64 of the UTF-8 content), whose result is
  reshaped into the `data` described there (`path`, `content`, `entries`). A
  non-zero exit code from the command is an SDK error for these helpers, not a
  scenario failure to hide.
- `docks.files.list` prints one base64-encoded entry name per line (the names
  are raw bytes, so a name may hold newlines); `data.entries` is each non-empty
  line decoded as base64, then as UTF-8. Order is not fixed. Hidden entries are
  included, `.` and `..` are not, a symlink to a directory lists the target's
  entries, and a path that is not a directory exits non-zero.
- File helpers are shell commands, so the SDK must quote the path: `{path}`
  becomes one single-quoted word with each `'` written as `'\''`
  (`it's.txt` -> `'it'\''s.txt'`), and `--` stops option parsing. Content is
  never placed in the command as text, only as base64. Never substitute a raw
  path: a name like `x'; rm -rf ~; '` would run as a command. The exec command
  limit (64 KB) caps one write at about 48 KB of content. A path may end in a
  newline; the commands handle it.

### File helper errors

A file helper that cannot return its `data` raises an SDK error with one of
these codes (not an API envelope code):

| Code | When |
|---|---|
| `output_truncated` | the exec result has `truncated: true`, so the output is incomplete |
| `file_command_failed` | the command exits non-zero |
| `file_too_large` | the rendered command exceeds the exec limit (64 KB UTF-8); raised client-side before anything is sent |

Every SDK must use these codes. `usedock/dock-js` uses `file_error` today and
must change to match.

The validation spec checks every `http` op against the route decorators in
`apps/backend/src/**/*.controller.ts`, so a renamed or removed route fails CI
here.

## Runner contract

A runner in an SDK repo must:

1. Load every `scenarios/*.yaml` (a new file is picked up with no code change)
   and run each as its own test, validating it against
   `schema/scenario.schema.json` first.
2. For each step, in order: substitute variables in `args`, map `op` to the
   SDK call (an `http` op to the matching client method, a `composite` op to
   the matching helper), call it, and normalise the outcome to a response
   envelope `{ status, ok, code?, data? }`. A failed call surfaces as
   `ok: false` with the API error code, so SDK error types must expose the
   HTTP status and `code`.
3. Apply `capture`, then assert `expect`. On a success step the response
   status must equal `expect.status` when given, else the op's `status` in
   `ops.yaml`. The first failed assertion stops the
   steps, and the runner reports the scenario, step id and the diff.
4. Always run `cleanup`, in order, after the steps whether or not they
   passed. A cleanup step is skipped when it references a variable that was
   never captured, and its errors (including 404 `dock_not_found` for a dock a
   step already deleted) are ignored. A runner may also track every dock id
   returned by `docks.create` and `docks.branch` and delete leftovers.
5. Use the public SDK surface only, with no raw HTTP, so the scenarios test the
   SDK and not the runner.

Names created by scenarios start with `sdk-` so leaked docks are easy to find.

## Run modes

### Real Dock

Set `DOCK_API_URL` (the control-plane origin, without `/v1`), `DOCK_API_KEY`
(`dock_...`) and `DOCK_WORKSPACE_ID` (a workspace the key can create docks in).
Without them the real-Dock tests are skipped. Scenarios create and delete docks,
so run them against a throwaway workspace. File content lives under
`/home/user/work`, which persists on both runtimes (`microvm`, `gvisor`).

### Recorded fake

`fixtures/<name>.json` holds the exchanges a scenario makes, so an SDK can run
it offline against a tiny HTTP server with no Dock:

```json
{
  "scenario": "create-exec-delete",
  "variables": { "workspaceId": "aaaaaaaa-...", "run": "fixture" },
  "exchanges": [
    {
      "step": "create",
      "request": {
        "method": "POST",
        "path": "/v1/docks",
        "headers": { "x-confirm-delete": "..." },
        "body": { "workspaceId": "aaaaaaaa-...", "cpus": 1 }
      },
      "response": { "status": 201, "body": { "ok": true, "data": { "id": "..." } } }
    }
  ]
}
```

- Start the fake on a local port, point the SDK at it with any API key, and
  seed the runner's variables from `variables` (instead of the environment) so
  request bodies match.
- A request matches the first unused exchange with the same method and exact
  path whose `body` is a subset of the request JSON body and whose `headers`
  (lower-case names) are a subset of the request headers. A matched exchange is
  used once and answered with its `response` (`body` is the full envelope).
- A request that matches nothing is answered `404` with
  `{"ok":false,"code":"dock_not_found","message":"Dock not found"}`. This is what
  makes cleanup of an already-deleted dock harmless.
- `step` is the step id, or `cleanup.<index>` for a cleanup step that sends a
  request; it is documentation for humans and drives the validation spec.
- Fixtures are hand-maintained from the real API shapes; when a scenario or op
  changes, update the fixture in the same change.

## Validation

```
cd sdk-scenarios
bun install
bunx tsc --noEmit
bunx vitest run
```

The spec validates every scenario against the schema, checks that every op
exists with known args, that every `http` op is a real backend route, that
captured variables are defined before use, and that each scenario has a fixture
whose exchanges line up with its steps. CI runs it as the `sdk-scenarios` job.

## Adding a scenario

Add `scenarios/<name>.yaml`, a matching `fixtures/<name>.json`, and any new op
to `ops.yaml` in the same PR as the API change it covers, then update the SDK
repos' pinned copy.
