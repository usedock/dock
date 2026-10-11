import { MAX_REPLY_CHARS, redactSecrets } from './connector-redact';

describe('redactSecrets', () => {
  it.each([
    ['Sentry user token', 'sntryu_' + 'a1b2c3d4e5f6a7b8'],
    ['Sentry org token', 'sntrys_' + 'eyJpYXQiOjE2ODg'],
    ['Slack bot token', 'xoxb-' + '1234567890-abcdefABCDEF'],
    ['Slack user token', 'xoxp-' + '1234567890-abcdefABCDEF'],
    ['Linear key', 'lin_api_' + 'abcdefghijklmnop1234'],
    ['Figma token', 'figd_' + 'abcdefghijklmnop-1234'],
    ['Anthropic key', 'sk-ant-' + 'api03-abcdefghijklmnop'],
    ['OpenAI key', 'sk-' + 'proj1234567890abcdefghij'],
    ['GitHub token', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123'],
    ['GitHub fine-grained', 'github_pat_' + '11ABCDEFG0abcdefghijklmnop'],
    ['AWS access key', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['Dock key', 'dock_' + 'abcdefghijklmnop1234'],
    ['Dock token', 'ab'.repeat(32)],
    ['bearer header', 'Bearer ' + 'abcdefghijklmnopqrstuv'],
  ])('removes a %s', (_name, secret) => {
    const out = redactSecrets(`token is ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
    expect(out).toContain('ok');
  });

  it('removes exact secret values the run held, however they look', () => {
    expect(redactSecrets('the password is hunter2hunter2 and again hunter2hunter2', ['hunter2hunter2'])).toBe('the password is [redacted] and again [redacted]');
  });

  it('leaves ordinary text alone and caps the length', () => {
    expect(redactSecrets('Fixed the null check in app/main.ts, tests pass.')).toBe('Fixed the null check in app/main.ts, tests pass.');
    const out = redactSecrets('x'.repeat(MAX_REPLY_CHARS + 500));
    expect(out.length).toBe(MAX_REPLY_CHARS + 3);
    expect(out.endsWith('...')).toBe(true);
  });
});
