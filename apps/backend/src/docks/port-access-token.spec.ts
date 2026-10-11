import { edgeProof, edgeProofValid } from './port-access-token';

const label = '3000-abcdefghijkmnpqr';
const cfg = (extra: Record<string, string> = {}) => ({ get: (k: string) => ({ BETTER_AUTH_SECRET: 'test-secret', ...extra })[k] as never });

describe('edge proof', () => {
  const now = 1_700_000_000_000;

  it('is v1.<seconds>.<hmac> and accepts a fresh proof for its label', () => {
    const proof = edgeProof(cfg(), label, now);
    expect(proof).toMatch(/^v1\.1700000000\.[0-9a-f]{64}$/);
    expect(edgeProofValid(cfg(), label, proof, now + 59_000)).toBe(true);
  });

  it('refuses a proof older than 60s or far in the future', () => {
    const proof = edgeProof(cfg(), label, now);
    expect(edgeProofValid(cfg(), label, proof, now + 61_000)).toBe(false);
    expect(edgeProofValid(cfg(), label, proof, now - 10_000)).toBe(false);
  });

  it('refuses another label, a re-stamped timestamp, and malformed values', () => {
    const proof = edgeProof(cfg(), label, now);
    expect(edgeProofValid(cfg(), '8080-zzzzzzzzzzzzzzzz', proof, now)).toBe(false);
    const [v, , sig] = proof.split('.');
    expect(edgeProofValid(cfg(), label, `${v}.1700000030.${sig}`, now + 30_000)).toBe(false);
    for (const bad of [null, '', 'v1', 'v1.x.y', `v2.1700000000.${sig}`, `${proof}.extra`, 'v1.1700000000.zz']) {
      expect(edgeProofValid(cfg(), label, bad, now)).toBe(false);
    }
  });

  it('uses a dedicated key when DOCK_PORT_PROOF_SECRET is set, independent of the auth secret', () => {
    const dedicated = cfg({ DOCK_PORT_PROOF_SECRET: 'proof-secret' });
    const proof = edgeProof(dedicated, label, now);
    expect(proof).not.toBe(edgeProof(cfg(), label, now));
    expect(edgeProofValid(dedicated, label, proof, now)).toBe(true);
    expect(edgeProofValid(cfg(), label, proof, now)).toBe(false);
    const rotatedAuth = cfg({ BETTER_AUTH_SECRET: 'other', DOCK_PORT_PROOF_SECRET: 'proof-secret' });
    expect(edgeProofValid(rotatedAuth, label, proof, now)).toBe(true);
  });

  it('follows the auth secret when no dedicated secret is set', () => {
    expect(edgeProofValid(cfg({ BETTER_AUTH_SECRET: 'different' }), label, edgeProof(cfg(), label, now), now)).toBe(false);
  });
});
