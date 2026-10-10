---
name: pr-review
description: Dock pull request review checklist - correctness, security, tenancy, migrations, API contract, dashboard conventions, self-host deploy, tests. Use for "/pr-review <number|branch>", "review this PR", or a pre-submit review of local changes. Run by the Opus reviewer agent.
---

# PR review

Argument: a PR number, a branch name, or nothing (review local changes against `main`).

## 1. Scope

```bash
gh pr view <n> -R usedock/dock --json title,body,baseRefName,headRefName,files   # PR
gh pr diff <n> -R usedock/dock                                                   # PR diff
git diff main...HEAD && git diff                                 # local changes
```

Read the linked issue. Read every changed file in full, not only the hunks, plus the callers of changed functions. Note which apps are touched. The fleet API is the contract with `usedock/docklet`: flag changes to it.

## 2. Checklist

Only check the sections for apps the diff touches.

### All
- Does the change do what the issue's Acceptance list says, and nothing unrelated?
- Dead code, commented-out code, duplicated logic that already exists elsewhere.
- Comments are short one-liners explaining why; no paragraph comments; no emojis in code, comments or commits.
- No secrets, tokens, `.env` contents, or private files committed.
- Product vocabulary: `Dock`, `Environment`, `Snapshot`, `Branch`, `Template`, `Run`, `Workspace` ... never `box` or `computer`. Docks are general-purpose sandboxes; nothing frames them by GitHub origin.

### Backend (`apps/backend`)
- Every behavior change has colocated `*.spec.ts` that would fail without the change.
- Auth: new routes are behind `JwtAuthGuard` unless deliberately `@Public()`; ownership checked so one user/workspace cannot read or mutate another's docks, snapshots, environments, keys, runs.
- Validation: DTOs with `class-validator`; no unvalidated `any` from request bodies; env via `validate-env.ts`.
- Errors: `HttpException` with snake_case `code`; controllers thin; POSTs have explicit `@HttpCode`.
- DB: schema change has a generated Drizzle migration committed; multi-table writes in `db.transaction`; indexes for new lookups; no N+1 in list endpoints.
- Security: secrets and tokens stored hashed/encrypted only; no secrets or PII in logs; Redis errors fail closed where they gate auth or rate limits.
- Async: no unawaited promises; timeouts on outbound calls; lifecycle operations stay idempotent and safe to retry.

### API contract, docs
- Request/response shape changes are reflected in the hand-written docs page in `documentation`.
- Envelope stays `{ok:true,data}` / `{ok:false,code,message}`; breaking changes are called out in the PR.

### Dashboard (`apps/dashboard`)
- shadcn primitives + Tailwind utilities only; no hand-written CSS, `<style>` blocks or new global stylesheets.
- Clean, minimal design (plain backgrounds, clean sans, one accent).
- `'use client'` only where needed; loading, empty and error states handled; mobile layout not broken.

### Deploy and self-host (`deploy/`, compose files, scripts)
- New env vars added to `.env.example` and documented; defaults safe.
- `setup.sh` stays re-runnable; shell scripts keep LF line endings.

## 3. Verify

- Run the checks for touched packages (see `.claude/skills/github-workflow/SKILL.md` step 4) and record the results.
- For each candidate finding, confirm it in the code and write the concrete failure: input or state, then the wrong result. Drop anything you cannot confirm.

## 4. Output

```markdown
## Review: <PR title or branch>

**Verdict:** approve | changes requested

### Blocking
1. `path:line` - <defect>. Failure: <concrete scenario>. Fix: <suggestion>.

### Non-blocking
1. `path:line` - <issue and suggestion>.

### Checks
- `<command>`: pass | fail (<summary>)
```

Blocking means a correctness bug, security or tenancy hole, data loss risk, missing test for a behavior change, or a broken check. Everything else is non-blocking. Keep empty sections with "None."
