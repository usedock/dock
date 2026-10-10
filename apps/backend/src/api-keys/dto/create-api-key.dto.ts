import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Key creation payload; service trims the name and rejects past expiries. */
export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
