import { IsString, MaxLength, MinLength } from 'class-validator';

export class PutRepoLinkDto {
  /** Linear team id, Slack channel id, Sentry project slug, Figma file key, or `*` for every subject. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  scope!: string;

  /** `owner/repo`. */
  @IsString()
  @MinLength(3)
  @MaxLength(140)
  repo!: string;
}

export class DeleteRepoLinkQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  scope!: string;
}
