import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_IMAGE } from '../../database/schema';
import { DockSizeDto } from './dock-size.dto';

export class CreateDockDto extends DockSizeDto {
  @IsUUID()
  workspaceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({ required: false, description: 'Unique per workspace; generated when omitted' })
  name?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ required: false, default: DEFAULT_IMAGE, description: 'Only ubuntu-24.04 is available' })
  image?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(2592000)
  @ApiProperty({ required: false, type: 'integer', nullable: true, minimum: 60, maximum: 2592000, description: 'Seconds after the dock becomes ready before it is stopped automatically; null (default) disables auto-stop' })
  ttlSeconds?: number | null;

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  environment?: string;

  @IsOptional()
  @IsBoolean()
  noEnv?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(65536)
  setupScript?: string;
}
