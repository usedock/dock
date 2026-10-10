import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ENV_NAME_RE, SECRETS_ACCESS, type SecretsAccess } from '../../database/schema';

/** Environment creation payload; content starts as an empty v1. */
export class CreateEnvironmentDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(ENV_NAME_RE, { message: 'Name must be 2-64 lowercase letters, digits, dash, or underscore' })
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsIn(SECRETS_ACCESS)
  @ApiProperty({ required: false, enum: SECRETS_ACCESS, description: "Who can launch docks that receive this environment's secrets, files and credentials. Anyone who can launch such a dock can read them inside it. Defaults to admins." })
  secretsAccess?: SecretsAccess;
}

/** Rename, default move, and posture toggles; posture saves bump the version. */
export class UpdateEnvironmentDto {
  @IsOptional()
  @IsString()
  @Matches(ENV_NAME_RE, { message: 'Name must be 2-64 lowercase letters, digits, dash, or underscore' })
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(SECRETS_ACCESS)
  @ApiProperty({ required: false, enum: SECRETS_ACCESS, description: "Who can launch docks that receive this environment's secrets, files and credentials. Anyone who can launch such a dock can read them inside it." })
  secretsAccess?: SecretsAccess;

  @IsOptional()
  @IsBoolean()
  safeForThirdParties?: boolean;

  @IsOptional()
  @IsBoolean()
  passGithub?: boolean;

  @IsOptional()
  @IsBoolean()
  passSecrets?: boolean;

  @IsOptional()
  @IsBoolean()
  passDockCredentials?: boolean;

  @IsOptional()
  @IsBoolean()
  passAgentsCredentials?: boolean;
}

/** Name refs resolve within this org; id refs ignore it. */
export class EnvironmentRefQuery {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

/** Listing is always scoped to one organization. */
export class ListEnvironmentsQuery {
  @IsUUID()
  organizationId!: string;
}

/** Restrict an upgrade to these docks; omitted moves every older dock. */
export class UpgradeEnvironmentDto {
  @IsOptional()
  @IsUUID('all', { each: true })
  dockIds?: string[];
}
