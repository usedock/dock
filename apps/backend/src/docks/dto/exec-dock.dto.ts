import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class ExecDockDto {
  /** Shell command, run as the dock user under `bash -lc`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(65536)
  command!: string;

  /** Seconds before the command is killed (default 60); capped by the deployment's exec budget. */
  @ApiProperty({ type: 'integer', required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  timeoutSeconds?: number;

  /** Extra environment for this call only; never stored on the dock. */
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  /** Absolute working directory; defaults to /home/user/work. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^\/[^\0\n\r]*$/)
  cwd?: string;
}

export class DockExecResultDto {
  /** Process exit status. */
  @ApiProperty({ type: 'integer' })
  exitCode!: number;

  /** Captured standard output, UTF-8, at most 1 MiB. */
  stdout!: string;

  /** Captured standard error, UTF-8, at most 1 MiB. */
  stderr!: string;

  /** Wall time from request to result, including host dispatch. */
  @ApiProperty({ type: 'integer' })
  durationMs!: number;

  /** True when stdout or stderr was clipped to its first 1 MiB. */
  truncated!: boolean;
}
