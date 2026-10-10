import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { SLUG_RE } from '../../organizations/slug';

/** Workspace creation payload; slug derives from the name when omitted. */
export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_RE, { message: 'Slug must be 3-63 lowercase letters, digits, or hyphens' })
  @MaxLength(63)
  slug?: string;
}
