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

  it('rejects malformed base fingerprints', async () => {
    const errors = await errorsFor({ baseFingerprints: ['../../etc/passwd'] });
    expect(errors.map((e) => e.property)).toEqual(['baseFingerprints']);
    expect(await errorsFor({ baseFingerprints: ['A'.repeat(64)] })).toHaveLength(1);
  });
});
