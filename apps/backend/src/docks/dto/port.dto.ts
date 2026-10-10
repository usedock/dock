import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class ExposePortDto {
  /** TCP port inside the dock; services bound to localhost are reachable. */
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
}

export class DockPortDto {
  @ApiProperty({ type: 'integer' })
  port!: number;

  /** Public URL serving the port; null while hosted ports are off on this deployment. */
  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  createdAt!: Date;
}
