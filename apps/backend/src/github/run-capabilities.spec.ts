import {
  RUN_CAPABILITY_VERSION,
  missingRunCapabilities,
  normalizeRunCapabilities,
  satisfiesRunCapabilities,
} from './run-capabilities';

describe('run capabilities', () => {
  it('normalizes supported boolean capabilities', () => {
    expect(normalizeRunCapabilities({ docker: true, browser: false })).toEqual({ docker: true, browser: false });
    expect(RUN_CAPABILITY_VERSION).toBe(1);
  });

  it('rejects unknown and non-boolean capabilities', () => {
    expect(() => normalizeRunCapabilities({ gpu: true })).toThrow('Unknown capability: gpu');
    expect(() => normalizeRunCapabilities({ docker: 'yes' })).toThrow('Capability docker must be boolean');
  });

  it('fails closed when an offered provider misses a requested capability', () => {
    const requested = normalizeRunCapabilities({ docker: true, networkPolicy: true });
    const offered = normalizeRunCapabilities({ networkPolicy: true });
    expect(missingRunCapabilities(requested, offered)).toEqual(['docker']);
    expect(satisfiesRunCapabilities(requested, offered)).toBe(false);
    expect(satisfiesRunCapabilities(requested, { docker: true, networkPolicy: true })).toBe(true);
  });
});
