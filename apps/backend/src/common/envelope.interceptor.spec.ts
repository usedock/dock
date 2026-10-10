import { lastValueFrom, of } from 'rxjs';
import { EnvelopeInterceptor } from './envelope.interceptor';

describe('EnvelopeInterceptor', () => {
  const ctx = {} as never;
  let interceptor: EnvelopeInterceptor;

  beforeEach(() => {
    interceptor = new EnvelopeInterceptor();
  });

  function handle(value: unknown) {
    return { handle: () => of(value) } as never;
  }

  it('wraps an object payload as { ok: true, data }', async () => {
    const payload = { id: 1, name: 'dock' };
    const result = await lastValueFrom(interceptor.intercept(ctx, handle(payload)));
    expect(result).toEqual({ ok: true, data: payload });
  });

  it('maps undefined to data: null', async () => {
    const result = await lastValueFrom(interceptor.intercept(ctx, handle(undefined)));
    expect(result).toEqual({ ok: true, data: null });
  });

  it('maps null to data: null', async () => {
    const result = await lastValueFrom(interceptor.intercept(ctx, handle(null)));
    expect(result).toEqual({ ok: true, data: null });
  });

  it('passes primitives through as data', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(ctx, handle('hello'))),
    ).resolves.toEqual({ ok: true, data: 'hello' });
    await expect(
      lastValueFrom(interceptor.intercept(ctx, handle([1, 2, 3]))),
    ).resolves.toEqual({ ok: true, data: [1, 2, 3] });
  });
});
