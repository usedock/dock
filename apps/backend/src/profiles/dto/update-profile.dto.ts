import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

/** All fields optional; each present field validated before any write. */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  displayName?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;
}
