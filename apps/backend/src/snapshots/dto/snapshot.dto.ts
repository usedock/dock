import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SnapshotQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SaveTemplateDto {
  @IsString()
  dockId!: string;

  @IsString()
  @MaxLength(64)
  name!: string;
}

/** Organization a template name is resolved in; names are unique per org only. */
export class TemplateOrgQuery {
  @IsUUID()
  organizationId!: string;
}
