import { candidateSlug, personalSlug, slugify, SLUG_RE } from './slug';

describe('slug helpers', () => {
  it('slugify lowercases and swaps separators for single dashes', () => {
    expect(slugify('  Acme Corp. 2026 ')).toBe('acme-corp-2026');
    expect(slugify('Ada+test@example')).toBe('ada-test-example');
    expect(slugify('--Trim--Me--')).toBe('trim-me');
  });

  it('SLUG_RE accepts shaped slugs and rejects short or illegal ones', () => {
    expect(SLUG_RE.test('acme')).toBe(true);
    expect(SLUG_RE.test('a1-b2-c3')).toBe(true);
    expect(SLUG_RE.test('Abc')).toBe(false);
    expect(SLUG_RE.test('-abc')).toBe(false);
    expect(SLUG_RE.test('ab')).toBe(false);
    expect(SLUG_RE.test('has space')).toBe(false);
  });

  it('candidateSlug derives from names and pads stubs', () => {
    expect(candidateSlug('Acme')).toBe('acme');
    expect(candidateSlug('AI')).toBe('ai-org');
    expect(candidateSlug('!!!')).toBe('org');
  });

  it('personalSlug suffixes the email local part with a random tail', () => {
    const slug = personalSlug('Ada@Example.com');
    expect(slug).toMatch(/^ada-[0-9a-f]{6}$/);
    expect(SLUG_RE.test(slug)).toBe(true);
  });
});
