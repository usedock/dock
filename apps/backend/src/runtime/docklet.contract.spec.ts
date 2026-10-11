import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validate } from 'class-validator';
import { FleetHeartbeatDto, FleetRegisterDto, HostCommandResultDto, HostSampleDto, HostWorkloadDto } from '../fleet/dto/fleet.dto';
import type { RegisterResult } from '../fleet/fleet.service';
import { EGRESS_ON_RESUME, VERIFIED_IMPORTS } from '../hosts/host-features';
import type { HostCommandPayload, HostCommandQueue } from '../fleet/host-command-queue';
import {
  DockletClient,
  DockletException,
  type DockletContainerSample,
  type DockletFastRunCapabilities,
  type DockletFastRunCreate,
  type DockletFastRunExec,
  type DockletFastRunExecResult,
  type DockletFastRunRead,
  type DockletFastRunReadResult,
  type DockletProvision,
  type DockletResources,
  type DockletSample,
  type DockletStatus,
  type DockletTransport,
} from './docklet.client';
import { FleetHostAgent } from './fleet-host-agent';
import type { HostAgent } from './host-agent';

const dir = join(__dirname, '__fixtures__', 'docklet-api-v1');
const raw = (file: string) => readFileSync(join(dir, file), 'utf8');
const load = (file: string): Record<string, any> => JSON.parse(raw(file));
const sortedKeys = (value: object) => Object.keys(value).sort();

// Compile-time: a table names exactly the keys of its client type (tsconfig.contract.json runs tsc on this file).
type KeyTable<T> = Record<keyof T, true>;
const table = <T>(keys: KeyTable<T>): string[] => Object.keys(keys);
type Result<K extends keyof HostAgent> = Awaited<ReturnType<HostAgent[K]>>;

// Fixtures whose top-level keys must equal a client type's keys.
const typed: Record<string, string[]> = {
  'resources.json': table<DockletResources>({ cpus: true, memoryMiB: true, diskGiB: true }),
  'fast-run-capabilities.json': table<DockletFastRunCapabilities>({ version: true, target: true, profile: true, capabilities: true }),
  'provision-request.json': table<DockletProvision>({
    dockId: true,
    resources: true,
    image: true,
    snapshotId: true,
    execAgent: true,
    egressAllow: true,
    idempotencyToken: true,
  }),
  'provision-response.json': table<Result<'provision'>>({ ip: true, hostId: true }),
  'snapshot-load-response.json': table<Result<'snapshotLoad'>>({ ip: true, hostId: true }),
  // A delta answers baseFingerprint; a full capture answers sha256 and baseImage instead.
  'snapshot-create-response.json': ['snapshotId', 'sizeBytes', 'cpuFamily', 'baseFingerprint'],
  'snapshot-create-response-full.json': ['snapshotId', 'sizeBytes', 'cpuFamily', 'sha256', 'baseImage'],
  'fast-run-create-request.json': table<DockletFastRunCreate>({
    runtimeId: true,
    resources: true,
    image: true,
    capabilities: true,
    egressAllow: true,
    guestToken: true,
    idempotencyToken: true,
  }),
  'fast-run-create-response.json': table<Result<'fastRunCreate'>>({ runtimeId: true, ip: true, hostId: true, capabilities: true }),
  'fast-run-exec-request.json': table<DockletFastRunExec>({ runtimeId: true, script: true, timeoutSeconds: true, env: true, idempotencyToken: true }),
  'fast-run-exec-response.json': table<DockletFastRunExecResult>({ runtimeId: true, exitCode: true, stdout: true, stderr: true, truncated: true, timedOut: true }),
  'fast-run-read-request.json': table<DockletFastRunRead>({ runtimeId: true, path: true, idempotencyToken: true }),
  'fast-run-read-response.json': table<DockletFastRunReadResult>({ runtimeId: true, path: true, content: true, sizeBytes: true }),
  'stats-sample.json': table<DockletSample>({
    dockId: true,
    at: true,
    source: true,
    cpuPercent: true,
    memBytes: true,
    memLimit: true,
    diskBytes: true,
    diskUsedBytes: true,
    rxBytes: true,
    txBytes: true,
    containers: true,
  }),
  'container-sample.json': table<DockletContainerSample>({ name: true, cpuPercent: true, memBytes: true }),
  'running-vm.json': table<DockletStatus['running'][number]>({ dockId: true, state: true, kind: true }),
  'fleet-register-response.json': table<RegisterResult>({ hostId: true, heartbeatSeconds: true, pollWaitSeconds: true, credential: true }),
  'fleet-command.json': table<HostCommandPayload>({ id: true, op: true, idempotencyToken: true, deadlineMs: true, payload: true }),
};

// Request fixtures replayed through both host agents; the sent body must match.
const requests: Record<string, (agent: HostAgent, f: Record<string, any>) => Promise<unknown>> = {
  'provision-request.json': (a, f) => a.provision(f as DockletProvision),
  'pause-request.json': (a, f) => a.pause(f.dockId),
  'destroy-request.json': (a, f) => a.destroy(f.dockId),
  'snapshot-create-request.json': (a, f) => a.snapshotCreate(f.dockId, f.parentId, f.kind, f.resumeAfter, f.memory, f.idempotencyToken),
  'snapshot-create-request-full.json': (a, f) => a.snapshotCreate(f.dockId, f.parentId, f.kind, f.resumeAfter, f.memory, f.idempotencyToken, f.full),
  'snapshot-load-request.json': (a, f) => a.snapshotLoad(f.dockId, f.resources, f.snapshotId, f.execAgent, f.egressAllow),
  'fast-run-create-request.json': (a, f) => a.fastRunCreate(f as DockletFastRunCreate),
  'fast-run-exec-request.json': (a, f) => a.fastRunExec(f as DockletFastRunExec),
  'fast-run-read-request.json': (a, f) => a.fastRunRead(f as DockletFastRunRead),
  'fast-run-terminate-request.json': (a, f) => a.fastRunTerminate(f.runtimeId, f.idempotencyToken),
};

// The direct client sends these ops' token only as the idempotency-token header, which the docklet falls back to.
const headerTokenOnly = new Set(['pause-request.json', 'destroy-request.json', 'snapshot-load-request.json']);

// Fleet bodies the docklet sends, validated as the control plane does (main.ts ValidationPipe).
const fleetDtos: Record<string, new () => object> = {
  'fleet-register-request.json': FleetRegisterDto,
  'fleet-register-request-verified-imports.json': FleetRegisterDto,
  'fleet-heartbeat-request.json': FleetHeartbeatDto,
  'fleet-heartbeat-request-gvisor.json': FleetHeartbeatDto,
  'fleet-heartbeat-request-images.json': FleetHeartbeatDto,
  'fleet-result-ok.json': HostCommandResultDto,
  'fleet-result-error.json': HostCommandResultDto,
};

const covered = [
  'fleet-poll-response.json',
  'fleet-poll-response-empty.json',
  'envelope-ok.json',
  'envelope-capacity-exhausted.json',
  // Docklet-only shapes the backend never parses: local /v1/heartbeat ignores its body; readiness is not called.
  'heartbeat-request.json',
  'readiness-ready.json',
  'readiness-not-ready.json',
];

const dtoKeys = (dto: Function) => [...new Set(getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false).map((m) => m.propertyName))].sort();

describe('docklet api/v1 fixtures vs client types', () => {
  it('classifies every fixture file', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const known = new Set([...Object.keys(typed), ...Object.keys(requests), ...Object.keys(fleetDtos), ...covered]);
    expect(files.filter((f) => !known.has(f))).toEqual([]);
    expect([...known].filter((f) => !files.includes(f))).toEqual([]);
  });

  it('covers every snapshot answer key between the delta and full fixtures', () => {
    const client = table<Result<'snapshotCreate'>>({ snapshotId: true, sizeBytes: true, cpuFamily: true, baseFingerprint: true, sha256: true, baseImage: true });
    const answered = new Set([...typed['snapshot-create-response.json'], ...typed['snapshot-create-response-full.json']]);
    expect([...answered].sort()).toEqual(client.sort());
  });

  it.each(Object.keys(typed))('%s has exactly the client keys', (file) => {
    expect(sortedKeys(load(file))).toEqual([...typed[file]].sort());
  });

  it('keeps nested resources, capabilities, samples and inventory in the client shape', () => {
    const resources = typed['resources.json'].sort();
    const caps = typed['fast-run-capabilities.json'].sort();
    const create = load('fast-run-create-request.json');
    expect(sortedKeys(create.resources)).toEqual(resources);
    expect(sortedKeys(create.capabilities)).toEqual(caps);
    expect(sortedKeys(load('fast-run-create-response.json').capabilities)).toEqual(caps);
    expect(sortedKeys(load('provision-request.json').resources)).toEqual(resources);
    expect(sortedKeys(load('snapshot-load-request.json').resources)).toEqual(resources);
    expect(sortedKeys(load('stats-sample.json').containers[0])).toEqual(typed['container-sample.json'].sort());
    expect(sortedKeys(load('heartbeat-request.json').runningVms[0])).toEqual(typed['running-vm.json'].sort());
  });
});

describe('host agents send the docklet request fixtures', () => {
  const recordClient = () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const transport: DockletTransport = async (_method, _url, headers, body) => {
      sent.push({ body: JSON.parse(body), headers });
      return { status: 200, text: JSON.stringify({ ok: true, data: {} }) };
    };
    const config = { get: () => undefined } as unknown as ConfigService;
    return { agent: new DockletClient(config, transport, 'http://docklet:8081'), sent };
  };
  const recordFleet = () => {
    const sent: Array<{ body: Record<string, unknown>; token: string }> = [];
    const queue = {
      execute: async (_host: string, _op: string, body: Record<string, unknown>, token: string) => {
        sent.push({ body, token });
        return {};
      },
    } as unknown as HostCommandQueue;
    return { agent: new FleetHostAgent(queue, 'h1'), sent };
  };
  const withoutToken = ({ idempotencyToken: _t, ...rest }: Record<string, unknown>) => rest;

  it.each(Object.keys(requests))('%s via DockletClient', async (file) => {
    const fixture = load(file);
    const { agent, sent } = recordClient();
    await requests[file](agent, fixture);
    const [{ body, headers }] = sent;
    if (headerTokenOnly.has(file)) {
      expect(body).toEqual(withoutToken(fixture));
      expect(headers['idempotency-token']).toEqual(expect.any(String));
    } else {
      expect(withoutToken(body)).toEqual(withoutToken(fixture));
      expect(sortedKeys(body)).toEqual(sortedKeys(fixture));
    }
  });

  it.each(Object.keys(requests))('%s via FleetHostAgent', async (file) => {
    const fixture = load(file);
    const { agent, sent } = recordFleet();
    await requests[file](agent, fixture);
    const [{ body, token }] = sent;
    expect(withoutToken(body)).toEqual(withoutToken(fixture));
    expect(sortedKeys(body)).toEqual(sortedKeys(fixture));
    expect(body.idempotencyToken).toBe(token);
  });
});

describe('fleet fixtures vs control-plane DTOs', () => {
  it.each(Object.keys(fleetDtos))('%s passes the fleet ValidationPipe', async (file) => {
    const errors = await validate(plainToInstance(fleetDtos[file], load(file)), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.toString())).toEqual([]);
  });

  it('declares no DTO field the docklet never sends', () => {
    const sentBy = (dto: Function) =>
      new Set(
        Object.entries(fleetDtos)
          .filter(([, d]) => d === dto)
          .flatMap(([file]) => Object.keys(load(file))),
      );
    for (const dto of [FleetRegisterDto, FleetHeartbeatDto, HostCommandResultDto]) {
      expect(dtoKeys(dto).filter((k) => !sentBy(dto).has(k))).toEqual([]);
    }
    const heartbeat = load('fleet-heartbeat-request.json');
    expect(sortedKeys(heartbeat.samples[0])).toEqual(dtoKeys(HostSampleDto));
    expect(sortedKeys(heartbeat.running[0])).toEqual(dtoKeys(HostWorkloadDto));
  });

  it('carries the host runtime on register and heartbeat', () => {
    expect(load('fleet-register-request.json').runtime).toBe('microvm');
    expect(load('fleet-heartbeat-request.json').runtime).toBe('microvm');
    expect(load('fleet-heartbeat-request-gvisor.json').runtime).toBe('gvisor');
  });

  it('registers the features the control plane places by', () => {
    expect(load('fleet-register-request-verified-imports.json').features).toEqual([EGRESS_ON_RESUME, VERIFIED_IMPORTS]);
  });

  it('polls a command in the queue payload shape, or null', () => {
    const poll = load('fleet-poll-response.json');
    expect(sortedKeys(poll)).toEqual(['command']);
    expect(sortedKeys(poll.command)).toEqual(typed['fleet-command.json'].sort());
    expect(load('fleet-poll-response-empty.json')).toEqual({ command: null });
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
