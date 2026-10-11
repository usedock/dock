import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class ConnectConnectorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;
}

export class SetWebhookDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  secret?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  externalId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedUsers?: string[];

  @IsOptional()
  @IsBoolean()
  triggersEnabled?: boolean;
}

export class ConnectorOauthStartQuery {
  @IsString()
  @MaxLength(36)
  workspaceId!: string;
}

export class CompleteConnectorRunDto {
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
}

/** One changed file relative to the run's start commit; only used when the run is linked to a repository. */
export class ConnectorRunChangeDto {
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

export class CompleteConnectorRunChangesDto extends CompleteConnectorRunDto {
  @IsOptional()
  @Matches(/^[0-9a-f]{40}$/)
  parentSha?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ConnectorRunChangeDto)
  changes?: ConnectorRunChangeDto[];
}
