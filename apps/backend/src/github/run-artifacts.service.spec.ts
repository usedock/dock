import { RunArtifactsService } from './run-artifacts.service';
import { vi } from 'vitest';

describe('RunArtifactsService', () => {
  it('publishes bounded evidence with stable hashes and lists it after cleanup', async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => {
              const row = { id: 'artifact-1', createdAt: new Date(0), ...value };
              rows.push(row);
              return [row];
            }),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => rows),
        })),
      })),
    };
    const service = new RunArtifactsService(db as never);
    const published = await service.publish('run-1', { 'RESULT.json': '{"status":"fixed"}', 'test.log': 'ok\n' });
    expect(published).toHaveLength(2);
    expect(published[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(service.list('run-1')).resolves.toEqual(published);
  });
});
