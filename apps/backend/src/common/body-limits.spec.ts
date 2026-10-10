import { Body, Controller, Module, Post, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import { registerBodyLimits } from './body-limits';

// Decorators applied as calls: the spec transform does not parse decorator syntax.
class EchoController {
  echo(body: unknown) {
    return { body };
  }

  raw(req: Request) {
    return { raw: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null };
  }
}
const proto = EchoController.prototype;
const method = (name: keyof EchoController) => Object.getOwnPropertyDescriptor(proto, name)!;
Controller()(EchoController);
Post(['docks', 'github/runs/:id/complete', 'docks/:id/exec', 'fleet/commands/:id/result'])(proto, 'echo', method('echo'));
Body()(proto, 'echo', 0);
Post('llm/anthropic')(proto, 'raw', method('raw'));
Req()(proto, 'raw', 0);

class EchoModule {}
Module({ controllers: [EchoController] })(EchoModule);

describe('registerBodyLimits', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(EchoModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('v1');
    registerBodyLimits(app.getHttpAdapter().getInstance());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json());

  it('keeps Nest parsing JSON on every other route', async () => {
    expect(await post('/docks', '{"workspaceId":"w1"}')).toEqual({ body: { workspaceId: 'w1' } });
  });

  it('parses large run completions and forwards gateway bytes untouched', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    expect(await post('/github/runs/r1/complete', JSON.stringify({ summary: big }))).toEqual({ body: { summary: big } });
    expect(await post('/llm/anthropic', '{"model":"m"}')).toEqual({ raw: '{"model":"m"}' });
  });

  it('takes 64KB exec commands and multi-MiB host exec results', async () => {
    const command = '"'.repeat(64 * 1024);
    expect(await post('/docks/d1/exec', JSON.stringify({ command }))).toEqual({ body: { command } });
    const stdout = 'y'.repeat(3 * 1024 * 1024);
    expect(await post('/fleet/commands/c1/result', JSON.stringify({ data: { stdout } }))).toEqual({ body: { data: { stdout } } });
  });
});
