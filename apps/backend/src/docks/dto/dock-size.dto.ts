import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Per-dock size; upper bounds come from host capacity at placement. */
export class DockSizeDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 64, default: 2 })
  cpus?: number;

  @IsOptional()
  @IsInt()
  @Min(512)
  @Max(262144)
  @ApiProperty({ required: false, type: 'integer', minimum: 512, maximum: 262144, default: 4096 })
  memoryMiB?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2048)
  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 2048, default: 20 })
  diskGiB?: number;
}
