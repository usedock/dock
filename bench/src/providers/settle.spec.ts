import { describe, expect, it } from 'vitest';
import { createAll } from './settle.ts';

describe('createAll', () => {
  it('returns every handle when all creates succeed', async () => {
    let i = 0;
    const made = await createAll(3, async () => ({ id: `c${++i}` }), async () => undefined);
    expect(made.map((h) => h.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('destroys the copies already made when one create fails, then rethrows', async () => {
    let i = 0;
    const destroyed: string[] = [];
    const err = await createAll(
      3,
      async () => {
        const n = ++i;
        if (n === 2) throw new Error('quota');
        await new Promise((r) => setTimeout(r, 5));
        return { id: `c${n}` };
      },
      async (h) => {
        destroyed.push(h.id);
      },
    ).catch((e) => e);
    expect(err.message).toBe('quota');
    // A late success after the failure is destroyed too, not leaked.
    expect(destroyed.sort()).toEqual(['c1', 'c3']);
  });
});
