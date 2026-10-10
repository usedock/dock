import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DockSizeDto } from './dock-size.dto';

export class UpdateDockDto extends DockSizeDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(2592000)
  @ApiProperty({ required: false, type: 'integer', nullable: true, minimum: 60, maximum: 2592000, description: 'Seconds after the dock becomes ready before it is stopped automatically; null (default) disables auto-stop' })
  ttlSeconds?: number | null;
}

export class ResumeDockDto extends DockSizeDto {
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(2592000)
  @ApiProperty({ required: false, type: 'integer', nullable: true, minimum: 60, maximum: 2592000, description: 'Seconds after the dock becomes ready before it is stopped automatically; null (default) disables auto-stop' })
  ttlSeconds?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  environment?: string;

  @IsOptional()
  @IsBoolean()
  noEnv?: boolean;
}
