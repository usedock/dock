import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

async function errorsFor(plain: object) {
  return validate(plainToInstance(UpdateProfileDto, plain));
}

function props(errors: Array<{ property: string }>) {
  return errors.map((e) => e.property);
}

describe('UpdateProfileDto', () => {
  it('accepts an empty object', async () => {
    expect((await errorsFor({})).length).toBe(0);
  });

  it('rejects an empty displayName', async () => {
    const errors = await errorsFor({ displayName: '' });
    expect(errors.length).toBeGreaterThan(0);
    expect(props(errors)).toContain('displayName');
  });

  it('rejects a 61-char displayName', async () => {
    const errors = await errorsFor({ displayName: 'a'.repeat(61) });
    expect(errors.length).toBeGreaterThan(0);
    expect(props(errors)).toContain('displayName');
  });

  it('accepts a 60-char displayName', async () => {
    expect((await errorsFor({ displayName: 'a'.repeat(60) })).length).toBe(0);
  });

  it("rejects 'not-a-url' as avatarUrl", async () => {
    const errors = await errorsFor({ avatarUrl: 'not-a-url' });
    expect(errors.length).toBeGreaterThan(0);
    expect(props(errors)).toContain('avatarUrl');
  });

  it('rejects a protocol-relative avatarUrl', async () => {
    const errors = await errorsFor({ avatarUrl: '//x/y.png' });
    expect(errors.length).toBeGreaterThan(0);
    expect(props(errors)).toContain('avatarUrl');
  });

  it('accepts an https avatarUrl', async () => {
    expect((await errorsFor({ avatarUrl: 'https://example.com/y.png' })).length).toBe(0);
  });

  it('rejects a 281-char bio', async () => {
    const errors = await errorsFor({ bio: 'a'.repeat(281) });
    expect(errors.length).toBeGreaterThan(0);
    expect(props(errors)).toContain('bio');
  });

  it('accepts a 280-char bio', async () => {
    expect((await errorsFor({ bio: 'a'.repeat(280) })).length).toBe(0);
  });
});
