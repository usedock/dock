import { ForbiddenException } from '@nestjs/common';
import { AgentCredentialsService, ProviderKeysNotFoundException } from './agent-credentials.service';
import { OrganizationNotFoundException } from '../organizations/organizations.service';
import { vi, type Mock } from 'vitest';

type Row = Record<string, unknown>;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function selectQ(rows: Row[]) {
  const end = Object.assign([...rows], { limit: vi.fn().mockResolvedValue(rows) });
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(end) }) };
}

function keyRow(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: ORG,
    provider: 'openai',
    secret: { iv: 'aXY=', tag: 'bGc=', data: 'c2VhbGVk' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

describe('AgentCredentialsService', () => {
  let db: { select: Mock; insert: Mock; delete: Mock };
  let orgs: { requireMembership: Mock };
  let service: AgentCredentialsService;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), delete: vi.fn() };
    orgs = { requireMembership: vi.fn().mockResolvedValue({ role: 'admin' }) };
    const config = { getOrThrow: vi.fn().mockReturnValue('ab'.repeat(32)) };
    service = new AgentCredentialsService(db as never, orgs as never, config as never);
  });

  describe('set', () => {
    function mockUpsert() {
      const returning = vi.fn().mockResolvedValue([keyRow()]);
      const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
      (db.insert as Mock).mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate }) });
    }

    it('seals the key at rest and returns metadata without the value', async () => {
      mockUpsert();
      const meta = await service.set('u1', ORG, 'openai', 'sk-live');
      expect(meta).toEqual({ provider: 'openai', configured: true, updatedAt: expect.any(Date) });
      const values = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0];
      expect(values.provider).toBe('openai');
      expect(JSON.stringify(values.secret)).not.toContain('sk-live');
      expect(values.secret).toEqual({ iv: expect.any(String), tag: expect.any(String), data: expect.any(String) });
    });

    it('rejects unknown providers and blank keys without touching the database', async () => {
      await expect(service.set('u1', ORG, 'anthropic-x', 'sk')).rejects.toMatchObject({ status: 400 });
      await expect(service.set('u1', ORG, 'openai', '  ')).rejects.toMatchObject({ status: 400 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('lets forbidden member errors through and maps strangers to 404', async () => {
      mockUpsert();
      orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
      await expect(service.set('u1', ORG, 'openai', 'sk')).rejects.toMatchObject({ status: 403 });
      orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
      await expect(service.set('u1', ORG, 'openai', 'sk')).rejects.toBeInstanceOf(ProviderKeysNotFoundException);
    });
  });

  describe('list', () => {
    it('reports configured flags with no secret material', async () => {
      (db.select as Mock).mockReturnValue(selectQ([keyRow()]));
      const metas = await service.list('u1', ORG);
      expect(metas).toEqual([
        { provider: 'anthropic', configured: false, updatedAt: null },
        { provider: 'openai', configured: true, updatedAt: new Date('2026-01-02T00:00:00Z') },
        { provider: 'openrouter', configured: false, updatedAt: null },
        { provider: 'opencode', configured: false, updatedAt: null },
      ]);
      expect(JSON.stringify(metas)).not.toContain('c2VhbGVk');
    });

    it('maps strangers to 404', async () => {
      orgs.requireMembership.mockRejectedValueOnce(new OrganizationNotFoundException());
      await expect(service.list('u1', ORG)).rejects.toBeInstanceOf(ProviderKeysNotFoundException);
    });
  });

  describe('reveal', () => {
    it('returns plaintext to admins by opening the sealed value', async () => {
      (db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([keyRow()]) }),
        }),
      });
      await service.set('u1', ORG, 'anthropic', 'sk-ant-secret');
      const stored = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0].secret;
      (db.select as Mock).mockReturnValue(selectQ([keyRow({ provider: 'anthropic', secret: stored })]));
      await expect(service.reveal('u1', ORG, 'anthropic')).resolves.toEqual({ provider: 'anthropic', key: 'sk-ant-secret' });
    });

    it('rejects members with 403 and reports missing keys as 404', async () => {
      (db.select as Mock).mockReturnValue(selectQ([keyRow()]));
      orgs.requireMembership.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden', message: 'no' }));
      await expect(service.reveal('u1', ORG, 'openai')).rejects.toMatchObject({ status: 403 });
      (db.select as Mock).mockReturnValue(selectQ([]));
      await expect(service.reveal('u1', ORG, 'openai')).rejects.toBeInstanceOf(ProviderKeysNotFoundException);
      await expect(service.reveal('u1', ORG, 'nope')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('remove', () => {
    it('deletes the row and reports unconfigured', async () => {
      const returning = vi.fn().mockResolvedValue([{ id: 'k1' }]);
      (db.delete as Mock).mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
      await expect(service.remove('u1', ORG, 'openai')).resolves.toEqual({ provider: 'openai', configured: false, updatedAt: null });
    });

    it('reports missing keys as 404', async () => {
      const returning = vi.fn().mockResolvedValue([]);
      (db.delete as Mock).mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
      await expect(service.remove('u1', ORG, 'openai')).rejects.toBeInstanceOf(ProviderKeysNotFoundException);
    });
  });

  describe('varsFor', () => {
    it('fills only wanted vars from configured providers', async () => {
      (db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([keyRow()]) }),
        }),
      });
      await service.set('u1', ORG, 'openai', 'sk-o');
      await service.set('u1', ORG, 'anthropic', 'sk-a');
      const openaiSealed = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0].secret;
      const anthropicSealed = (db.insert as Mock).mock.results[1].value.values.mock.calls[0][0].secret;
      (db.select as Mock).mockReturnValue(
        selectQ([
          keyRow({ provider: 'openai', secret: openaiSealed }),
          keyRow({ provider: 'anthropic', secret: anthropicSealed }),
        ]),
      );
      await expect(service.varsFor(ORG, ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'])).resolves.toEqual({
        vars: { OPENAI_API_KEY: 'sk-o' },
        providers: ['openai'],
      });
      await expect(service.varsFor(ORG, [])).resolves.toEqual({ vars: {}, providers: [] });
    });

    it('fills OPENCODE_API_KEY from the opencode provider for Zen and Go models', async () => {
      (db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([keyRow()]) }),
        }),
      });
      await service.set('u1', ORG, 'opencode', 'sk-oc');
      const sealed = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0].secret;
      (db.select as Mock).mockReturnValue(selectQ([keyRow({ provider: 'opencode', secret: sealed })]));
      await expect(service.varsFor(ORG, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY'])).resolves.toEqual({
        vars: { OPENCODE_API_KEY: 'sk-oc' },
        providers: ['opencode'],
      });
    });
  });
});
