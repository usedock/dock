import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ContactDto } from './contact.dto';

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(ContactDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@acme.dev',
  company: 'Acme',
  topic: 'request-access',
  message: 'We need a dock per task.',
};

function properties(errors: { property: string }[]): string[] {
  return errors.map((e) => e.property).sort();
}

describe('ContactDto', () => {
  it('accepts a complete submission and trims the text fields', async () => {
    const dto = plainToInstance(ContactDto, {
      ...valid,
      name: '  Ada Lovelace  ',
      company: '  Acme ',
      message: '  We need a dock per task.  ',
    });

    await expect(validate(dto, { whitelist: true })).resolves.toEqual([]);
    expect(dto.name).toBe('Ada Lovelace');
    expect(dto.company).toBe('Acme');
    expect(dto.message).toBe('We need a dock per task.');
  });

  it('accepts the cloud-waitlist topic', async () => {
    await expect(errorsFor({ ...valid, topic: 'cloud-waitlist' })).resolves.toEqual([]);
  });

  it('requires name, email, topic, and message', async () => {
    const errors = await errorsFor({
      name: '',
      email: '',
      topic: '',
      message: '',
    });

    expect(properties(errors)).toEqual(['email', 'message', 'name', 'topic']);
  });

  it('rejects a malformed email and an unknown topic', async () => {
    const errors = await errorsFor({ ...valid, email: 'not-an-email', topic: 'sales' });

    expect(properties(errors)).toEqual(['email', 'topic']);
  });

  it('caps the message at what the form allows', async () => {
    const errors = await errorsFor({ ...valid, message: 'x'.repeat(4001) });

    expect(properties(errors)).toEqual(['message']);
  });

  it('rejects unknown fields instead of silently dropping them', async () => {
    const errors = await errorsFor({ ...valid, organizationId: 'o1' });

    expect(properties(errors)).toEqual(['organizationId']);
  });
});
