import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DockSizeDto } from './dock-size.dto';

async function badProps(payload: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(DockSizeDto, payload), { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property).sort();
}

describe('DockSizeDto', () => {
  it('accepts sizes up to the upper bounds', async () => {
    expect(await badProps({ cpus: 64, memoryMiB: 262144, diskGiB: 2048 })).toEqual([]);
    expect(await badProps({})).toEqual([]);
  });

  it('rejects values that would overflow int4 columns', async () => {
    expect(await badProps({ cpus: 65 })).toEqual(['cpus']);
    expect(await badProps({ memoryMiB: 262145 })).toEqual(['memoryMiB']);
    expect(await badProps({ diskGiB: 2049 })).toEqual(['diskGiB']);
    expect(await badProps({ cpus: 2147483648, memoryMiB: 2147483648, diskGiB: 2147483648 })).toEqual(['cpus', 'diskGiB', 'memoryMiB']);
  });
});
