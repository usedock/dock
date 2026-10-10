import type { Handle } from './types.ts';

/** Starts n creates in parallel; if any fails, the ones that succeeded are destroyed so nothing leaks. */
export async function createAll<T extends Handle>(n: number, make: () => Promise<T>, destroy: (h: T) => Promise<void>): Promise<T[]> {
  const settled = await Promise.allSettled(Array.from({ length: n }, make));
  const made = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) {
    await Promise.allSettled(made.map(destroy));
    throw failed.reason;
  }
  return made;
}
