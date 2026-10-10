@AGENTS.md

# Where things live

This repo (`usedock/dock`) is the open core: `apps/backend`, `apps/dashboard`, `deploy/self-host`, `documentation`. The docklet lives in `usedock/docklet`. The marketing site and cloud-only code live in private repos. Make a change in the repo that owns the code.

# Claude Code

## Model roles

Every non-trivial task runs as orchestrated subagents. The main session does not write feature code itself.

| Role | Model | Agent | Does |
|---|---|---|---|
| Orchestrator | Opus | main session | Breaks the task down, writes the issue, dispatches subagents, integrates their results, runs checks, opens the PR |
| Explore | Haiku | `explorer` | Read-only search: finds files, call sites, patterns and existing conventions, returns locations plus a short summary |
| Implement | Sonnet | `implementer` | Writes the code and the colocated tests for one scoped unit of work, runs that package's checks |
| Review | Opus | `reviewer` | Reviews the full diff against `.claude/skills/pr-review/SKILL.md` before the PR is opened and again before merge |

- Hand each implementer a self-contained brief: goal, files to touch, patterns to copy, tests to add, checks to run. Run independent implementers in parallel; never give two of them the same file.
- The orchestrator verifies implementer claims (reads the diff, reruns checks) instead of trusting the summary.
- Review findings go back to an implementer to fix, then the reviewer re-checks.
- Trivial edits (typo, one-line config) can skip the pipeline.

## GitHub workflow

Work flows issue → branch → implement → review → PR → merge. Big or multi-part work starts with an `epic:` parent issue whose pieces are GitHub sub-issues. Follow `.claude/skills/github-workflow/SKILL.md` (`/github-workflow`). The repo is `usedock/dock`.

## PR review

Every PR is reviewed with `.claude/skills/pr-review/SKILL.md` (`/pr-review <number|branch>`) by the Opus `reviewer` agent before it is opened and before it is merged. Blocking findings must be fixed before merge.

## Platform

Developed from Windows and Linux. Backend `env-apply-script.spec.ts` fails on Windows only (argv length limit); CI on Linux runs it.
