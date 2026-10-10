import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { DockletException } from '../runtime/docklet.client';
import { captureException, withScope } from '@sentry/nestjs';
import { vi } from 'vitest';

const mockScope = { setTag: vi.fn(), setUser: vi.fn() };
vi.mock('@sentry/nestjs', () => ({
  withScope: vi.fn((cb) => cb(mockScope)),
  captureException: vi.fn(),
}));

function setup() {
  const filter = new HttpExceptionFilter();
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as never;
  return { filter, res, host };
}

describe('HttpExceptionFilter', () => {
  it('preserves status, code and message from object body', () => {
    const { filter, res, host } = setup();
    filter.catch(new BadRequestException({ code: 'email_taken', message: 'Email taken' }), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'email_taken', message: 'Email taken' });
  });

  it('maps a docklet dock_busy refusal to a 409 conflict instead of a 500', () => {
    const { filter, res, host } = setup();
    filter.catch(new DockletException('dock_busy', 'another lifecycle operation is still running'), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'dock_busy', message: 'The dock is busy with another operation; retry shortly' });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('joins array messages with "; "', () => {
    const { filter, res, host } = setup();
    filter.catch(new BadRequestException({ code: 'bad', message: ['a', 'b'] }), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'bad', message: 'a; b' });
  });

  it('maps string body to message with code from status', () => {
    const { filter, res, host } = setup();
    filter.catch(new HttpException('boom', 403), host);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'forbidden', message: 'boom' });
  });

  it('falls back to codeForStatus when body has no code', () => {
    const { filter, res, host } = setup();
    filter.catch(new UnauthorizedException('nope'), host);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'unauthorized', message: 'nope' });
  });

  it('maps non-Http errors to 500 internal_error envelope', () => {
    const { filter, res, host } = setup();
    vi.spyOn(filter['logger'], 'error').mockImplementation();
    filter.catch(new Error('x'), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'internal_error', message: 'Internal server error' });
  });
});

describe('HttpExceptionFilter Sentry reporting', () => {
  function sentrySetup(user?: { id: string }) {
    const filter = new HttpExceptionFilter();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = {
      method: 'GET',
      path: '/v1/docks',
      url: '/v1/docks',
      route: { path: '/v1/docks' },
      headers: { 'x-request-id': 'cid-9' },
      ...(user ? { user } : {}),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as never;
    return { filter, res, host };
  }

  beforeEach(() => vi.clearAllMocks());

  it('captures a 500 HttpException exactly once with route and user context', () => {
    const { filter, res, host } = sentrySetup({ id: 'u-1' });
    filter.catch(new HttpException({ code: 'boom', message: 'boom' }, 500), host);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(withScope).toHaveBeenCalledTimes(1);
    expect(mockScope.setTag).toHaveBeenCalledWith('route', 'GET /v1/docks');
    expect(mockScope.setTag).toHaveBeenCalledWith('cid', 'cid-9');
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 'u-1' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'boom', message: 'boom' });
  });

  it('captures a non-Http error once', () => {
    const { filter, res, host } = sentrySetup();
    vi.spyOn(filter['logger'], 'error').mockImplementation();
    filter.catch(new Error('x'), host);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it.each([400, 401, 403, 404, 429])('never captures HTTP %i control-flow errors', (status) => {
    const { filter, host } = sentrySetup({ id: 'u-1' });
    filter.catch(new HttpException({ code: 'c', message: 'm' }, status), host);
    expect(withScope).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('never sends the user email, only the id', () => {
    const { filter, host } = sentrySetup({ id: 'u-1', email: 'ann@example.com' } as never);
    filter.catch(new HttpException({ code: 'boom', message: 'boom' }, 500), host);
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 'u-1' });
  });

  it('keeps the envelope when Sentry itself throws', () => {
    const { filter, res, host } = sentrySetup();
    vi.mocked(captureException).mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    vi.spyOn(filter['logger'], 'error').mockImplementation();
    expect(() => filter.catch(new Error('x'), host)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, code: 'internal_error', message: 'Internal server error' });
  });
});
