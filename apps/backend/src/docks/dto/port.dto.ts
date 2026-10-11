import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ExposePortDto {
  /** TCP port inside the dock; services bound to localhost are reachable. */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  /** Who may open the URL; defaults to `private` for a new port and leaves an existing port as is. */
  @ApiProperty({ enum: ['public', 'private'], required: false })
  @IsOptional()
  @IsIn(['public', 'private'])
  visibility?: 'public' | 'private';
}

export class DockPortDto {
  @ApiProperty({ type: 'integer' })
  port!: number;

  @ApiProperty({ enum: ['public', 'private'] })
  visibility!: 'public' | 'private';

  /** URL serving the port; null while hosted ports are off on this deployment. */
  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  createdAt!: Date;
}
