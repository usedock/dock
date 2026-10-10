import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  applyEnvelopeToDocument,
  applySecurityToDocument,
  collectPublicRoutes,
  normalizePathTemplates,
  normalizeRoutePath,
  readApiVersion,
} from './openapi-document';
import { Public } from './public.decorator';
import type { OpenAPIObject } from '@nestjs/swagger';
import pkg from '../../package.json';
import { FleetController } from '../fleet/fleet.controller';
import { LlmGatewayController } from '../github/llm-gateway.controller';

describe('readApiVersion', () => {
  it('locks the contract version to the package release', () => {
    expect(readApiVersion()).toBe((pkg as { version: string }).version);
  });
});

describe('normalizeRoutePath', () => {
  it('joins prefix, controller, and method paths', () => {
    expect(normalizeRoutePath('v1', 'docks', ':id/branch')).toBe('/v1/docks/{id}/branch');
  });

  it('drops empty segments and collapses slashes', () => {
    expect(normalizeRoutePath('v1', '', '/')).toBe('/v1');
  });

  it('accepts array paths from multi-path controllers', () => {
    expect(normalizeRoutePath('v1', ['a', 'b'], 'list')).toBe('/v1/a/b/list');
  });
});

describe('normalizePathTemplates', () => {
  it('restores the literal :verb for undeclared mid-segment templates', () => {
    const doc = {
      openapi: '3.0.0',
      paths: {
        '/v1/environments/{ref}/secrets{reveal}': {
          post: { parameters: [{ name: 'ref', in: 'path' }], responses: { '200': { description: '' } } },
        },
        '/v1/docks/{id}': {
          get: { parameters: [{ name: 'id', in: 'path' }], responses: { '200': { description: '' } } },
        },
      },
    } as unknown as OpenAPIObject;
    normalizePathTemplates(doc);
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      '/v1/docks/{id}',
      '/v1/environments/{ref}/secrets:reveal',
    ]);
  });
});

// Reads one response schema, skipping $ref pointers the passes never rewrite.
function jsonSchema(doc: OpenAPIObject, path: string, method: 'get' | 'post', status: string): unknown {
  const response = doc.paths[path]?.[method]?.responses[status];
  if (typeof response !== 'object' || response === null || '$ref' in response) return undefined;
  return response.content?.['application/json']?.schema;
}

describe('applyEnvelopeToDocument', () => {
  // Minimal shape; only paths/responses are exercised below.
  const fixture = {
    openapi: '3.0.0',
    paths: {
      '/v1/typed': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'string' } } } } } } },
      '/v1/bare': { post: { responses: { '201': { description: '' } } } },
      '/v1/input': {
        post: { requestBody: { content: {} }, responses: { '200': { description: '' } } },
      },
      '/v1/plain': { get: { responses: { '200': { description: '' } } } },
      '/v1/kept': {
        post: { requestBody: { content: {} }, responses: { '200': { description: '' }, '400': { description: 'Custom' } } },
      },
      '/v1/broken': { get: { responses: { '500': { description: 'Oops' } } } },
    },
  } as unknown as OpenAPIObject;

  it('wraps existing 2xx schemas preserving the payload under data', () => {
    const doc = structuredClone(fixture);
    applyEnvelopeToDocument(doc);
    const schema = jsonSchema(doc, '/v1/typed', 'get', '200');
    expect(schema).toMatchObject({ required: ['ok', 'data'], properties: { data: { type: 'string' } } });
  });

  it('declares the wrapper even when the 2xx response arrives schemaless', () => {
    const doc = structuredClone(fixture);
    applyEnvelopeToDocument(doc);
    const schema = jsonSchema(doc, '/v1/bare', 'post', '201');
    expect(schema).toMatchObject({ required: ['ok', 'data'] });
  });

  it('documents 400 only where the operation takes input, keeping explicit ones', () => {
    const doc = structuredClone(fixture);
    applyEnvelopeToDocument(doc);
    expect(doc.paths['/v1/input']?.post?.responses['400']).toMatchObject({ description: 'Validation failed' });
    expect(doc.paths['/v1/plain']?.get?.responses['400']).toBeUndefined();
    expect(doc.paths['/v1/kept']?.post?.responses['400']).toMatchObject({ description: 'Custom' });
  });

  it('leaves non-2xx responses alone', () => {
    const doc = structuredClone(fixture);
    applyEnvelopeToDocument(doc);
    expect(doc.paths['/v1/broken']?.get?.responses['500']).toEqual({ description: 'Oops' });
  });
});

describe('applySecurityToDocument', () => {
  const fixture = {
    openapi: '3.0.0',
    paths: {
      '/v1/open': { get: { security: [{ bearer: [] }], responses: { '200': { description: '' } } } },
      '/v1/locked': { get: { responses: { '200': { description: '' } } } },
      '/v1/custom401': { get: { responses: { '200': { description: '' }, '401': { description: 'Custom' } } } },
    },
  } as unknown as OpenAPIObject;

  it('clears security on public operations without adding 401', () => {
    const doc = structuredClone(fixture);
    applySecurityToDocument(doc, new Set(['GET /v1/open']));
    expect(doc.paths['/v1/open']?.get?.security).toEqual([]);
    expect(doc.paths['/v1/open']?.get?.responses['401']).toBeUndefined();
  });

  it('pins bearer and documents 401 on protected operations', () => {
    const doc = structuredClone(fixture);
    applySecurityToDocument(doc, new Set());
    expect(doc.paths['/v1/locked']?.get?.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/v1/locked']?.get?.responses['401']).toBeDefined();
  });

  it('documents dock_key_forbidden 403 on protected operations only', () => {
    const doc = structuredClone(fixture);
    applySecurityToDocument(doc, new Set(['GET /v1/open']));
    expect(doc.paths['/v1/locked']?.get?.responses['403']).toMatchObject({
      description: expect.stringContaining('dock_key_forbidden'),
    });
    expect(doc.paths['/v1/open']?.get?.responses['403']).toBeUndefined();
  });

  it('keeps an explicitly documented 401', () => {
    const doc = structuredClone(fixture);
    applySecurityToDocument(doc, new Set());
    expect(doc.paths['/v1/custom401']?.get?.responses['401']).toMatchObject({ description: 'Custom' });
  });
});

describe('collectPublicRoutes', () => {
  // Legacy decorator syntax is applied as plain calls: same metadata,
  // no transformer flag required.
  function decorateMethod(target: object, key: string, decorators: MethodDecorator[]): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) throw new Error(`missing descriptor for ${key}`);
    for (const apply of decorators) apply(target, key, descriptor);
  }

  class SamplePublicController {
    open() {
      return 'ok';
    }

    close() {
      return 'ok';
    }
  }
  Controller('sample')(SamplePublicController);
  Public()(SamplePublicController);
  decorateMethod(SamplePublicController.prototype, 'open', [Get('open')]);
  decorateMethod(SamplePublicController.prototype, 'close', [Post(':id/close')]);

  class SampleGuardedController {
    free() {
      return 'ok';
    }

    locked() {
      return 'ok';
    }
  }
  Controller('guarded')(SampleGuardedController);
  decorateMethod(SampleGuardedController.prototype, 'free', [Get('free'), Public()]);
  decorateMethod(SampleGuardedController.prototype, 'locked', [Get('locked')]);

  it('keys class- and method-level markers as METHOD /v1/path', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SamplePublicController, SampleGuardedController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    try {
      expect(collectPublicRoutes(app)).toEqual(
        new Set(['GET /v1/sample/open', 'POST /v1/sample/{id}/close', 'GET /v1/guarded/free']),
      );
    } finally {
      await app.close();
    }
  });
});

describe('internal channels', () => {
  it('keeps host and runner-only controllers out of the public contract', () => {
    for (const controller of [FleetController, LlmGatewayController]) {
      expect(Reflect.getMetadata('swagger/apiExcludeController', controller)).toEqual([true]);
    }
  });
});
