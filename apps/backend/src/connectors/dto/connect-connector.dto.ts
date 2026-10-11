import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
