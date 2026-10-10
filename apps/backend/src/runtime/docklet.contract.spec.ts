import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import {
  DockletClient,
  DockletException,
  type DockletFastRunCapabilities,
  type DockletFastRunCreate,
  type DockletFastRunExec,
  type DockletFastRunExecResult,
  type DockletFastRunRead,
  type DockletFastRunReadResult,
  type DockletProvision,
  type DockletResources,
  type DockletSample,
  type DockletTransport,
} from './docklet.client';

const dir = join(__dirname, '__fixtures__', 'docklet-api-v1');
const raw = (file: string) => readFileSync(join(dir, file), 'utf8');
const load = (file: string): Record<string, unknown> => JSON.parse(raw(file));

type Presence = 'req' | 'opt';
type KeyTable<T> = Record<keyof T, Presence>;
// Compile-time: a table must name every key of its client type.
const table = <T>(keys: KeyTable<T>): Record<string, Presence> => keys;

interface Spec {
  keys: Record<string, Presence>;
  // Keys the docklet sends or accepts that the client does not model.
  goOnly?: string[];
  // Keys the client sends that the docklet ignores.
  clientOnly?: string[];
}

const resources = table<DockletResources>({ cpus: 'req', memoryMiB: 'req', diskGiB: 'req' });
const caps = table<DockletFastRunCapabilities>({ version: 'req', target: 'req', profile: 'req', capabilities: 'req' });
const address: Record<string, Presence> = { ip: 'req', hostId: 'req' };

// Fixtures whose payload the client models, keyed by file name.
const specs: Record<string, Spec> = {
  'resources.json': { keys: resources },
  'fast-run-capabilities.json': { keys: caps },
  'provision-request.json': {
    keys: table<DockletProvision>({
      dockId: 'req',
      resources: 'req',
      image: 'req',
      snapshotId: 'opt',
      execAgent: 'opt',
      egressAllow: 'opt',
      idempotencyToken: 'req',
    }),
  },
  'provision-response.json': { keys: address },
  'snapshot-load-response.json': { keys: address },
  'pause-request.json': { keys: { dockId: 'req' }, goOnly: ['idempotencyToken'] },
  'destroy-request.json': { keys: { dockId: 'req' }, goOnly: ['idempotencyToken'] },
  'snapshot-create-request.json': {
    keys: { dockId: 'req', parentId: 'req', kind: 'req', resumeAfter: 'req', memory: 'req', idempotencyToken: 'req' },
  },
  'snapshot-create-response.json': {
    keys: { snapshotId: 'req', sizeBytes: 'req', cpuFamily: 'req', baseFingerprint: 'opt' },
  },
  'snapshot-load-request.json': {
    keys: { dockId: 'req', resources: 'req', image: 'req', snapshotId: 'req', execAgent: 'opt' },
    goOnly: ['idempotencyToken'],
    clientOnly: ['image'],
  },
  'fast-run-create-request.json': {
    keys: table<DockletFastRunCreate>({
      runtimeId: 'req',
      resources: 'req',
      image: 'req',
      capabilities: 'req',
      egressAllow: 'opt',
      guestToken: 'req',
      idempotencyToken: 'req',
    }),
  },
  'fast-run-create-response.json': { keys: { runtimeId: 'req', ip: 'req', hostId: 'req', capabilities: 'req' } },
  'fast-run-exec-request.json': {
    keys: table<DockletFastRunExec>({ runtimeId: 'req', script: 'req', timeoutSeconds: 'req', env: 'opt', idempotencyToken: 'req' }),
  },
  'fast-run-exec-response.json': {
    keys: table<DockletFastRunExecResult>({ runtimeId: 'req', exitCode: 'req', stdout: 'req', stderr: 'req', truncated: 'opt', timedOut: 'opt' }),
  },
  'fast-run-read-request.json': { keys: table<DockletFastRunRead>({ runtimeId: 'req', path: 'req', idempotencyToken: 'req' }) },
  'fast-run-read-response.json': {
    keys: table<DockletFastRunReadResult>({ runtimeId: 'req', path: 'req', content: 'req', sizeBytes: 'req' }),
  },
  'fast-run-terminate-request.json': { keys: { runtimeId: 'req', idempotencyToken: 'req' } },
  'stats-sample.json': {
    keys: table<DockletSample>({
      dockId: 'req',
      at: 'opt',
      source: 'opt',
      cpuPercent: 'req',
      memBytes: 'req',
      memLimit: 'req',
      diskBytes: 'req',
      diskUsedBytes: 'opt',
      rxBytes: 'req',
      txBytes: 'req',
    }),
    goOnly: ['containers'],
  },
  'running-vm.json': { keys: { dockId: 'req', state: 'req', kind: 'opt' } },
};

// Fixtures the client passes through untyped (heartbeat body, readiness, envelopes).
const untyped = [
  'container-sample.json',
  'heartbeat-request.json',
  'readiness-ready.json',
  'readiness-not-ready.json',
  'envelope-ok.json',
  'envelope-capacity-exhausted.json',
];

describe('docklet api/v1 fixtures vs client types', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('classifies every fixture file', () => {
    const known = new Set([...Object.keys(specs), ...untyped]);
    expect(files.filter((f) => !known.has(f))).toEqual([]);
    expect([...known].filter((f) => !files.includes(f))).toEqual([]);
  });

  it.each(Object.keys(specs))('%s matches the client shape', (file) => {
    const { keys, goOnly = [], clientOnly = [] } = specs[file];
    const present = Object.keys(load(file));
    const modelled = Object.keys(keys).filter((k) => !clientOnly.includes(k));
    // No fixture key outside the client or goOnly, and every client key is in the fixture.
    expect(present.filter((k) => !modelled.includes(k) && !goOnly.includes(k))).toEqual([]);
    expect(modelled.filter((k) => !present.includes(k))).toEqual([]);
  });

  it('keeps nested resources and capabilities in the client shape', () => {
    const create = load('fast-run-create-request.json');
    expect(Object.keys(create.resources as object).sort()).toEqual(Object.keys(resources).sort());
    expect(Object.keys(create.capabilities as object).sort()).toEqual(Object.keys(caps).sort());
    expect(Object.keys(load('provision-request.json').resources as object).sort()).toEqual(Object.keys(resources).sort());
  });
});

describe('DockletClient against docklet fixtures', () => {
  const client = (text: string, status = 200) => {
    const transport: DockletTransport = async () => ({ status, text });
    const config = { get: () => undefined } as unknown as ConfigService;
    return new DockletClient(config, transport, 'http://docklet:8081');
  };

  it('unwraps an ok envelope', async () => {
    await expect(client(raw('envelope-ok.json')).call('/v1/provision', {})).resolves.toEqual(load('envelope-ok.json').data);
  });

  it('maps capacity_exhausted to a DockletException', async () => {
    const err = await client(raw('envelope-capacity-exhausted.json'), 409)
      .call('/v1/provision', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockletException);
    expect((err as DockletException).code).toBe('capacity_exhausted');
  });

  it('returns exec response fixtures unchanged', async () => {
    const body = JSON.stringify({ ok: true, data: load('fast-run-exec-response.json') });
    await expect(client(body).fastRunExec({ runtimeId: 'rt', script: 'x', timeoutSeconds: 1, idempotencyToken: 't' })).resolves.toEqual(
      load('fast-run-exec-response.json'),
    );
  });
});
