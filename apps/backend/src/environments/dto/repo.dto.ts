import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Repository selection payload; stored connection-agnostic, cloned at start. */
export class AddRepoDto {
  @IsIn(['github', 'gitlab'])
  provider!: 'github' | 'gitlab';

  @IsString()
  @MaxLength(128)
  repositoryId!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { message: 'fullName must be owner/name' })
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  baseBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(65536)
  setupScript?: string;
}
