import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FleetHeartbeatDto } from './fleet.dto';

async function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(FleetHeartbeatDto, payload), { whitelist: true, forbidNonWhitelisted: true });
}

describe('FleetHeartbeatDto', () => {
  it('accepts sha256 base fingerprints, an empty list, or none', async () => {
    expect(await errorsFor({ running: [], baseFingerprints: ['a'.repeat(64)] })).toHaveLength(0);
    expect(await errorsFor({ running: [], baseFingerprints: [] })).toHaveLength(0);
    expect(await errorsFor({ running: [] })).toHaveLength(0);
  });

  it('accepts image names, an empty list, or none', async () => {
    expect(await errorsFor({ running: [], images: ['node-22', 'ubuntu-24.04'] })).toHaveLength(0);
    expect(await errorsFor({ running: [], images: [] })).toHaveLength(0);
    expect(await errorsFor({ running: [] })).toHaveLength(0);
  });

  it('rejects malformed image names', async () => {
    expect((await errorsFor({ images: ['../etc'] })).map((e) => e.property)).toEqual(['images']);
    expect(await errorsFor({ images: [1] })).toHaveLength(1);
  });

  it('rejects malformed base fingerprints', async () => {
    const errors = await errorsFor({ baseFingerprints: ['../../etc/passwd'] });
    expect(errors.map((e) => e.property)).toEqual(['baseFingerprints']);
    expect(await errorsFor({ baseFingerprints: ['A'.repeat(64)] })).toHaveLength(1);
  });
});
