import { HttpStatus } from '@nestjs/common';
import { utils } from 'ssh2';
import { vi, type Mock } from 'vitest';
import { parsePublicKey, sshFingerprint, SshKeysService } from './ssh-keys.service';

type Row = Record<string, unknown>;

const ed25519 = utils.generateKeyPairSync('ed25519');
const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 });

function mockSelectRows(db: { select: Mock }, rows: Row[]) {
  const end = Object.assign([...rows], { orderBy: vi.fn().mockResolvedValue(rows) });
  const where = vi.fn().mockReturnValue(end);
  (db.select as Mock).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
  return { where };
}

function keyRow(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    name: 'laptop',
    publicKey: 'ssh-ed25519 AAAA',
    fingerprint: 'SHA256:abc',
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('parsePublicKey', () => {
  it('canonicalizes ed25519 and RSA keys and strips the comment', () => {
    const parsed = parsePublicKey(`  ${ed25519.public} me@laptop  `);
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.canonical).toBe(ed25519.public.split(' ').slice(0, 2).join(' '));
    expect(parsePublicKey(rsa.public).type).toBe('ssh-rsa');
  });

  it('refuses private keys, garbage, multi-line input, and short RSA keys', () => {
    const weak = utils.generateKeyPairSync('rsa', { bits: 1024 });
    for (const bad of [ed25519.private, 'not a key', `${ed25519.public}\n${rsa.public}`, '', weak.public]) {
      expect(() => parsePublicKey(bad)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'validation_error' }) }));
    }
  });

  it('fingerprints like ssh-keygen -l', () => {
    const blob = Buffer.from(ed25519.public.split(' ')[1], 'base64');
    expect(sshFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe('SshKeysService', () => {
  let db: { select: Mock; insert: Mock; update: Mock; delete: Mock };
  let limits: { hit: Mock };
  let service: SshKeysService;

  beforeEach(() => {
    db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    limits = { hit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }) };
    service = new SshKeysService(db as never, limits as never);
  });

  it('stores the canonical key and its fingerprint', async () => {
    mockSelectRows(db, []);
    const returning = vi.fn().mockResolvedValue([keyRow()]);
    const values = vi.fn().mockReturnValue({ returning });
    db.insert.mockReturnValue({ values });
    await service.create('u1', '  laptop ', `${ed25519.public} me@laptop`);
    const stored = values.mock.calls[0][0];
    expect(stored).toMatchObject({ userId: 'u1', name: 'laptop', publicKey: parsePublicKey(ed25519.public).canonical });
    expect(stored.fingerprint).toBe(sshFingerprint(parsePublicKey(ed25519.public).blob));
    expect(limits.hit).toHaveBeenCalledWith('rl:sshkey:u1', 10, 3600);
  });

  it('refuses a key the user already added and caps keys at 20', async () => {
    const fingerprint = sshFingerprint(parsePublicKey(ed25519.public).blob);
    mockSelectRows(db, [{ id: 'k1', fingerprint }]);
    await expect(service.create('u1', 'again', ed25519.public)).rejects.toMatchObject({ status: HttpStatus.CONFLICT, response: { code: 'ssh_key_exists' } });
    mockSelectRows(db, Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, fingerprint: `SHA256:${i}` })));
    await expect(service.create('u1', 'one more', ed25519.public)).rejects.toMatchObject({ response: { code: 'ssh_key_limit_reached' } });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('validates before touching the limiter and maps exhaustion to 429', async () => {
    await expect(service.create('u1', ' ', ed25519.public)).rejects.toMatchObject({ response: { code: 'validation_error' } });
    await expect(service.create('u1', 'x', 'nope')).rejects.toMatchObject({ response: { code: 'validation_error' } });
    expect(limits.hit).not.toHaveBeenCalled();
    limits.hit.mockResolvedValue({ allowed: false, count: 11 });
    await expect(service.create('u1', 'x', ed25519.public)).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('lists metadata for the user', async () => {
    mockSelectRows(db, [keyRow()]);
    const rows = await service.list('u1');
    expect(rows).toEqual([expect.objectContaining({ id: keyRow().id, name: 'laptop', fingerprint: 'SHA256:abc' })]);
    expect(rows[0]).not.toHaveProperty('userId');
  });

  it('deletes owned keys and 404s unknown, foreign, or malformed ids', async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: 'k1' }]).mockResolvedValueOnce([]);
    db.delete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
    await expect(service.remove('u1', '11111111-1111-4111-8111-111111111111')).resolves.toEqual({ deleted: true });
    await expect(service.remove('u1', '22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND, response: { code: 'ssh_key_not_found' } });
    await expect(service.remove('u1', 'nope')).rejects.toMatchObject({ response: { code: 'ssh_key_not_found' } });
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it('finds keys by blob fingerprint', async () => {
    const { where } = mockSelectRows(db, [keyRow()]);
    const blob = parsePublicKey(ed25519.public).blob;
    await expect(service.findByBlob(blob)).resolves.toHaveLength(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
