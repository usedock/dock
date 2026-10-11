import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { codeForStatus } from './codes';
import { DockletException } from '../runtime/docklet.client';

/**
 * Maps every failure to `{ ok: false, code, message }`.
 * Controllers pass `{ code, message }` as the exception response to set
 * stable codes; otherwise the code derives from the HTTP status.
 */
// Minimal request surface for error context; never import auth here.
interface SentryRequestContext {
  method?: unknown;
  route?: { path?: unknown };
  headers?: Record<string, string | string[] | undefined>;
  user?: { id?: unknown };
}

/** body-parser's oversized-body error, raised before any controller runs. */
function isBodyTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const err = exception as { type?: unknown; status?: unknown };
  return err.type === 'entity.too.large' || (err.status === 413 && !(exception instanceof HttpException));
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (isBodyTooLarge(exception)) {
      // The client's fault, not a server fault: no Sentry report.
      res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ ok: false, code: 'payload_too_large', message: 'The request body is too large' });
      return;
    }
    this.reportToSentry(exception, host);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let code = codeForStatus(status);
      let message = exception.message;
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        if (typeof record.code === 'string') code = record.code;
        if (typeof record.message === 'string') {
          message = record.message;
        } else if (Array.isArray(record.message)) {
          message = record.message.map(String).join('; ');
        }
      } else if (typeof body === 'string' && body.length > 0) {
        message = body;
      }
      res.status(status).json({ ok: false, code, message });
      return;
    }

    if (exception instanceof DockletException && exception.code === 'dock_busy') {
      res
        .status(HttpStatus.CONFLICT)
        .json({ ok: false, code: 'dock_busy', message: 'The dock is busy with another operation; retry shortly' });
      return;
    }

    this.logger.error(
      'Unhandled error',
      exception instanceof Error ? exception.stack : String(exception),
    );
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ ok: false, code: 'internal_error', message: 'Internal server error' });
  }

  /** 5xx-only, fail-open Sentry capture; 4xx control-flow errors never report. */
  private reportToSentry(exception: unknown, host: ArgumentsHost): void {
    try {
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      if (status < 500) return;
      Sentry.withScope((scope) => {
        const req = host.switchToHttp().getRequest<SentryRequestContext>();
        if (req) {
          const method = typeof req.method === 'string' ? req.method : undefined;
          // Route template only: raw paths carry secrets such as invitation tokens.
          const path = typeof req.route?.path === 'string' ? req.route.path : undefined;
          if (method || path) scope.setTag('route', `${method ?? ''} ${path ?? ''}`.trim());
          const cid = req.headers?.['x-request-id'];
          if (typeof cid === 'string' && cid) scope.setTag('cid', cid);
          if (req.user && typeof req.user.id !== 'undefined') scope.setUser({ id: String(req.user.id) });
        }
        Sentry.captureException(exception);
      });
    } catch {
      // Reporting must never change the response.
    }
  }
}
