import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConnectConnectorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  token!: string;
}

export class ConnectorOauthStartQuery {
  @IsString()
  @MaxLength(36)
  workspaceId!: string;
}
