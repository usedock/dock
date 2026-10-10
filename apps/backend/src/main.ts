// Sentry first: init must run before any other import loads.
import './instrument';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ValidationError } from 'class-validator';
import { AppModule } from './app.module';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { HttpExceptionFilter } from './common/http-exception.filter';
import * as restate from '@restatedev/restate-sdk';
import { DocksService } from './docks/docks.service';
import { DockTerminalService } from './docks/dock-terminal.service';
import { DockSshGatewayService } from './docks/dock-ssh-gateway.service';
import { DockPortsService } from './docks/dock-ports.service';
import { buildRuntimeOps, dockObject, dockTtlWorkflow, setRuntimeOps } from './runtime/dock-workflow';
import type { NextFunction, Request, Response } from 'express';
import { buildOpenApiDocument } from './common/openapi-document';
import { registerBodyLimits } from './common/body-limits';
import { dockScopeMiddleware } from './auth/dock-scope';
import { BetterAuthService } from './auth/better-auth/better-auth.service';
import { publicApiUrl } from './config/instance';

function flattenErrors(errors: ValidationError[], parent = ''): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) messages.push(`${path}: ${Object.values(error.constraints).join(', ')}`);
    if (error.children?.length) messages.push(...flattenErrors(error.children, path));
  }
  return messages;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  app.setGlobalPrefix('v1');
  const http = app.getHttpAdapter().getInstance();
  registerBodyLimits(http);
  http.use(dockScopeMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          code: 'validation_error',
          message: flattenErrors(errors).join('; ') || 'Validation failed',
        }),
    }),
  );
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  // Raw OpenAPI contract for SDK/docs generation; no UI is served.
  const config = app.get(ConfigService);
  const document = buildOpenApiDocument(app, publicApiUrl(config));
  const instance = http;
  instance.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(document);
  });
  // Better Auth lives outside the /v1 prefix on raw Express: dashboard browsers
  // on another origin need credentialed CORS, which Nest never sees here.
  // Resolved here so auth misconfiguration fails the boot, not each request.
  const betterAuthService = app.get(BetterAuthService);
  instance.use('/api/auth', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && betterAuthService.trustedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    betterAuthService.handle(req, res, next);
  });
  app.get(DockTerminalService).attach(app.getHttpServer());
  await app.listen(config.get<number>('PORT', 8000));
  await app.get(DockSshGatewayService).listen();
  await app.get(DockPortsService).listen();
  // Restate driver serves durable dock workflows; fake mode binds nothing.
  if (config.get<string>('RUNTIME_DRIVER') === 'restate') {
    setRuntimeOps(buildRuntimeOps(app.get(DocksService)));
    await restate.serve({ services: [dockObject, dockTtlWorkflow], port: 9080 });
  }
}

void bootstrap();
