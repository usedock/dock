import { runView } from './run-view';
import type { GithubRun } from '../database/schema';

const row = {
  id: 'r1',
  installationId: 'i1',
  workspaceId: 'ws1',
  organizationId: 'org1',
  repo: 'acme/web',
  issueNumber: 42,
  triggerCommentId: 1001,
  deliveryGuid: 'guid-secret-1',
  hookId: 'hook-1',
  baseBranch: 'main',
  baseSha: 'abc123',
  dockId: 'd1',
  executionTarget: 'dock',
  requestedCapabilities: {},
  resolvedCapabilities: null,
  attemptId: 'attempt-secret-1',
  attemptNumber: 1,
  runtimeId: 'rt1',
  runtimeHostId: 'h1',
  artifactStatus: 'pending',
  artifactError: null,
  state: 'running',
  prNumber: 7,
  prUrl: 'https://github.com/acme/web/pull/7',
  failureReason: null,
  sealedToken: { ct: 'sealed-secret-value' },
  agent: 'opencode',
  testCommand: 'bun test',
  promptVersion: 'v1',
  envelopeHash: 'envelope-hash-secret',
  envelope: { issue: 'issue text', system: 'system text', constraints: 'c' },
  instructionFiles: [],
  branch: 'dock/run-r1',
  completionTokenHash: 'completion-hash-secret',
  gatewayTokenHash: 'gateway-hash-secret',
  model: 'm',
  llmUserId: 'u1',
  completionConsumed: false,
  completionStatus: null,
  events: [{ t: 'run.created', at: '2026-09-01T00:00:00.000Z' }],
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as GithubRun;

describe('runView', () => {
  it('returns exactly the public field set', () => {
    expect(Object.keys(runView(row)).sort()).toEqual(
      [
        'id', 'installationId', 'workspaceId', 'organizationId', 'repo', 'issueNumber', 'dockId', 'executionTarget',
        'state', 'prNumber', 'prUrl', 'failureReason', 'agent', 'branch', 'baseBranch', 'promptVersion', 'testCommand',
        'completionStatus', 'events', 'createdAt', 'updatedAt',
      ].sort(),
    );
  });

  it('never exposes sealed tokens, token hashes, envelope or attempt id', () => {
    const json = JSON.stringify(runView({ ...row, extraFutureColumn: 'future-secret' } as unknown as GithubRun));
    for (const leaked of [
      'sealed-secret-value', 'sealedToken', 'completion-hash-secret', 'gateway-hash-secret', 'envelope-hash-secret',
      'envelope', 'issue text', 'attempt-secret-1', 'guid-secret-1', 'extraFutureColumn', 'future-secret',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });
});
