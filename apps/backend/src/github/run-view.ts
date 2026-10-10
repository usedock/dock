import type { GithubRun, GithubRunState } from '../database/schema';

/** Public API shape of a run; built field by field so new columns are never exposed by default. */
export interface RunView {
  id: string;
  installationId: string;
  workspaceId: string;
  organizationId: string | null;
  repo: string;
  issueNumber: number;
  dockId: string | null;
  executionTarget: GithubRun['executionTarget'];
  state: GithubRunState;
  prNumber: number | null;
  prUrl: string | null;
  failureReason: string | null;
  agent: string;
  branch: string | null;
  baseBranch: string;
  promptVersion: string | null;
  testCommand: string | null;
  completionStatus: string | null;
  events: { t: string; at: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export function runView(run: GithubRun): RunView {
  return {
    id: run.id,
    installationId: run.installationId,
    workspaceId: run.workspaceId,
    organizationId: run.organizationId,
    repo: run.repo,
    issueNumber: run.issueNumber,
    dockId: run.dockId,
    executionTarget: run.executionTarget,
    state: run.state,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    failureReason: run.failureReason,
    agent: run.agent,
    branch: run.branch,
    baseBranch: run.baseBranch,
    promptVersion: run.promptVersion,
    testCommand: run.testCommand,
    completionStatus: run.completionStatus,
    events: run.events.map((e) => ({ t: e.t, at: e.at })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
