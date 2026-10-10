import { GithubController } from './github.controller';
import { GithubService } from './github.service';
import { vi, type Mocked } from 'vitest';

describe('GithubController', () => {
  const user = { id: 'user-1', email: 'o@x.co', emailVerified: true, isInteractive: true };
  let service: Mocked<
    Pick<GithubService, 'handleWebhookDelivery' | 'startInstallLink' | 'completeInstallLink' | 'updateInstallation' | 'listInstallations' | 'removeInstallation' | 'listRuns' | 'getRun' | 'promoteRun' | 'completeRun'>
  >;
  let controller: GithubController;

  beforeEach(() => {
    service = {
      handleWebhookDelivery: vi.fn(),
      startInstallLink: vi.fn(),
      completeInstallLink: vi.fn(),
      updateInstallation: vi.fn(),
      listInstallations: vi.fn(),
      removeInstallation: vi.fn(),
      listRuns: vi.fn(),
      getRun: vi.fn(),
      promoteRun: vi.fn(),
      completeRun: vi.fn(),
    };
    controller = new GithubController(service as never);
  });

  it('forwards raw bytes and headers to verification and mirrors the outcome status', async () => {
    service.handleWebhookDelivery.mockResolvedValue({ status: 202, body: { runId: 'run-1' } });
    const res = { status: vi.fn().mockReturnThis() };
    const rawBody = Buffer.from('{"action":"created"}');
    const out = await controller.webhook(
      { headers: { 'x-hub-signature-256': 'sha256=abc', 'x-github-delivery': 'guid-1', 'x-github-hook-id': 'hook-1', 'x-github-event': 'issue_comment' }, rawBody } as never,
      { action: 'created' },
      res as never,
    );
    expect(service.handleWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'sha256=abc', deliveryGuid: 'guid-1', hookId: 'hook-1', event: 'issue_comment', rawBody }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(out).toEqual({ runId: 'run-1' });
  });

  it('delegates installation and run reads with the caller identity', async () => {
    await controller.startInstallation(user as never, { workspaceId: 'ws-1' });
    expect(service.startInstallLink).toHaveBeenCalledWith(user, 'ws-1', undefined);
    await controller.completeInstallation(user as never, { installationId: 99, state: 'a'.repeat(32), code: 'abc' });
    expect(service.completeInstallLink).toHaveBeenCalledWith(user, { installationId: 99, state: 'a'.repeat(32), code: 'abc' });
    await controller.updateInstallation(user as never, 'map-1', { agent: 'opencode' });
    expect(service.updateInstallation).toHaveBeenCalledWith(user, 'map-1', { agent: 'opencode' });
    await controller.listRuns(user as never, { workspaceId: 'ws-1', state: 'done' });
    expect(service.listRuns).toHaveBeenCalledWith('user-1', 'ws-1', 'done');
    await controller.getRun(user as never, 'run-1');
    expect(service.getRun).toHaveBeenCalledWith('user-1', 'run-1');
  });

  it('delegates explicit Run promotion', async () => {
    await controller.promoteRun(user as never, 'run-1');
    expect(service.promoteRun).toHaveBeenCalledWith(user, 'run-1');
  });

  it('forwards the completion bearer without inspecting it', async () => {
    service.completeRun.mockResolvedValue({ id: 'run-1', completionStatus: 'fixed', envelope: { issue: 'x' }, completionTokenHash: 'h' } as never);
    const out = await controller.completeRun('run-1', { headers: { authorization: 'Bearer tok' } } as never, {
      status: 'fixed',
      summary: 'done',
    });
    // The guest learns the outcome only, never the run row.
    expect(out).toEqual({ runId: 'run-1', completionStatus: 'fixed' });
    expect(service.completeRun).toHaveBeenCalledWith(
      'run-1',
      'Bearer tok',
      expect.objectContaining({ status: 'fixed', summary: 'done' }),
    );
  });
});
