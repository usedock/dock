import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { SLUG_RE } from '../slug';

/** All fields optional; seats is checked against the live member count. */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_RE, { message: 'Slug must be 3-63 lowercase letters, digits, or hyphens' })
  @MaxLength(63)
  slug?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;
}
