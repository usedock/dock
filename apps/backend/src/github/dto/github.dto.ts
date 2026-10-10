import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { GITHUB_RUN_STATES } from '../../database/schema';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Workspace scope for installation reads. Required: no safe default. */
export class InstallationQuery {
  @IsUUID()
  workspaceId!: string;
}

export class StartInstallationDto {
  @IsUUID()
  workspaceId!: string;

  @IsOptional()
  @IsIn(['install', 'authorize'])
  mode?: 'install' | 'authorize';
}

/** What GitHub appends to the App's OAuth callback; `installationId` may be absent, `code` is absent on a picker follow-up. */
export class CompleteInstallationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  installationId?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/, { message: 'code must be the value GitHub returned' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{32}$/, { message: 'state must be the value issued when linking started' })
  state?: string;
}

export class UpdateInstallationDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(REPO_RE, { each: true, message: 'each repo must be owner/name' })
  repos?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  testCommand?: string;
}

/** One changed file relative to the guest's start commit. */
export class RunChangeDto {
  @IsString()
  @MaxLength(4096)
  path!: string;

  @IsOptional()
  @IsIn(['100644', '100755', '120000'])
  mode?: '100644' | '100755' | '120000';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9+/]*={0,2}$/, { message: 'content must be base64' })
  content?: string;

  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

export class CompleteRunDto {
  @IsString()
  @MaxLength(32)
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  testOk?: boolean;

  @IsOptional()
  @Matches(/^[0-9a-f]{40}$/)
  parentSha?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  commitMessage?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => RunChangeDto)
  changes?: RunChangeDto[];
}

export class RunsQuery extends InstallationQuery {
  @IsOptional()
  @IsIn([...GITHUB_RUN_STATES])
  state?: (typeof GITHUB_RUN_STATES)[number];
}

/** Optional GitHub organization login that will own the new App; empty registers it on the caller's account. */
export class StartAppManifestDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, { message: 'organization must be a GitHub login' })
  organization?: string;
}

/** The `code` and `state` GitHub appends to the manifest redirect. */
export class ConvertAppManifestDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/, { message: 'code must be the value GitHub returned' })
  code!: string;

  @IsString()
  @Matches(/^[0-9a-f]{32}$/, { message: 'state must be the value issued with the manifest' })
  state!: string;
}
