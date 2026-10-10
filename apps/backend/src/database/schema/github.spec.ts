import { getTableColumns } from 'drizzle-orm';
import {
  GITHUB_ARTIFACT_STATUSES,
  GITHUB_EXECUTION_TARGETS,
  githubRuns,
} from './github';

describe('github run schema', () => {
  it('keeps existing runs on the persistent Dock target by default', () => {
    const columns = getTableColumns(githubRuns);

    expect(GITHUB_EXECUTION_TARGETS).toEqual(['dock', 'fast']);
    expect(GITHUB_ARTIFACT_STATUSES).toEqual(['pending', 'published', 'failed']);
    expect(columns.executionTarget.notNull).toBe(true);
    expect(columns.executionTarget.hasDefault).toBe(true);
    expect(columns.requestedCapabilities.notNull).toBe(true);
    expect(columns.requestedCapabilities.hasDefault).toBe(true);
    expect(columns.attemptId.notNull).toBe(true);
    expect(columns.attemptId.hasDefault).toBe(true);
    expect(columns.artifactStatus.notNull).toBe(true);
    expect(columns.artifactStatus.hasDefault).toBe(true);
  });
});
