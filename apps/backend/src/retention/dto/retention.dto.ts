import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

/** Organization scope for account retention reads/writes. Required: no safe default. */
export class RetentionQuery {
  @IsUUID()
  organizationId!: string;
}

export class UpdateRetentionDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  confirmation?: string;
}
