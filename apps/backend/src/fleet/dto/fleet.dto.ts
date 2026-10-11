import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const RUNTIMES = ['microvm', 'gvisor'] as const;

/** Bootstrap request from a fresh machine; hostId is derived when omitted. */
export class EnrollDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hostId?: string;

  @IsOptional()
  @IsIn(RUNTIMES)
  runtime?: (typeof RUNTIMES)[number];
}

/** One runtime a host reports; mirrors the registry's workload shape. */
export class HostWorkloadDto {
  @IsString()
  @MaxLength(128)
  dockId!: string;

  @IsString()
  @MaxLength(32)
  state!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  kind?: string;
}

export class FleetRegisterDto {
  @IsString()
  @MaxLength(128)
  hostId!: string;

  /** Set by docklets that store the per-host credential; others stay credential-less. */
  @IsOptional()
  @IsBoolean()
  acceptsCredential?: boolean;

  /** Optional docklet behaviours, for example egress-on-resume. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  features?: string[];

  @IsString()
  @MaxLength(64)
  cpuFamily!: string;

  @IsString()
  @MaxLength(128)
  kernel!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  kernelRelease?: string | null;

  @IsOptional()
  @IsIn(RUNTIMES)
  runtime?: (typeof RUNTIMES)[number];

  @IsInt()
  @Min(0)
  vcpuTotal!: number;

  @IsInt()
  @Min(0)
  memTotalBytes!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  memBudgetBytes?: number;

  @IsInt()
  @Min(0)
  diskTotalBytes!: number;

  @IsInt()
  @Min(1)
  maxDocks!: number;
}

/** Guest-reported per-container breakdown; untrusted, hence the separate field. */
export class ContainerSampleDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsNumber()
  cpuPercent!: number;

  @IsNumber()
  memBytes!: number;
}

/** One host-truth sample, mirroring the docklet StatsSample exactly. */
export class HostSampleDto {
  @IsString()
  @MaxLength(128)
  dockId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;

  // Guest-reported breakdown stays separate from the host-truth counter so a
  // reader can always tell which numbers the host itself measured.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContainerSampleDto)
  containers?: ContainerSampleDto[];

  @IsNumber()
  cpuPercent!: number;

  @IsNumber()
  memBytes!: number;

  @IsNumber()
  memLimit!: number;

  @IsNumber()
  diskBytes!: number;

  // Occupancy of the dock's writable disk; feeds disk alerts, absent on older docklets.
  @IsOptional()
  @IsNumber()
  diskUsedBytes?: number;

  @IsNumber()
  rxBytes!: number;

  @IsNumber()
  txBytes!: number;
}

export class FleetHeartbeatDto {
  /** Informational: the host is derived from its credential, and a different value is refused. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hostId?: string;

  @IsOptional()
  @IsIn(RUNTIMES)
  runtime?: (typeof RUNTIMES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  usedDocks?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HostWorkloadDto)
  running?: HostWorkloadDto[];

  // Host-truth counters ride the heartbeat so stats never need a second
  // round trip; rejected payloads would stall host liveness entirely.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HostSampleDto)
  samples?: HostSampleDto[];

  /** Base image fingerprints a microVM host holds; absent on gVisor hosts and older docklets. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @Matches(/^[0-9a-f]{64}$/, { each: true })
  baseFingerprints?: string[];

  /** Image names the host serves (Dockyard images plus ubuntu-24.04); absent on gVisor hosts and older docklets, [] when none. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(/^[a-z0-9][a-z0-9._-]{0,63}$/, { each: true })
  images?: string[];
}

/** Result of one executed command; failure carries the docklet's own code. */
export class HostCommandResultDto {
  /** Informational: the host is derived from its credential, and a different value is refused. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hostId?: string;

  @IsBoolean()
  ok!: boolean;

  @IsOptional()
  data?: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  // Host errors carry real diagnostic text (tool output, stderr), so the
  // bound is generous; a rejected result would strand the command unclaimed.
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  message?: string;
}

/** S3 refuses a compose of more than 10k sources, so the part count is capped. */
export const MAX_OBJECT_PARTS = 10_000;

/**
 * Upload coordinates for one part of a generation object. `part` is 0-based
 * and part `parts - 1` is the last, which triggers composition.
 */
export class ObjectPartQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  part!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_OBJECT_PARTS)
  parts!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  size!: number;
}

const OBJECT_URL_OPS = ['put', 'get'] as const;

/**
 * Which way the host moves one object. `size` is what decides whether a single
 * presigned PUT can carry it, so the service requires it when uploading.
 */
export class ObjectUrlDto {
  @IsIn(OBJECT_URL_OPS)
  op!: (typeof OBJECT_URL_OPS)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;
}
