import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** Bulk secrets payload; omitted entries are dropped, not merged. */
export class BulkSecretsDto {
  @IsOptional()
  @IsString()
  envContents?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SecretFileDto)
  secretFiles?: SecretFileDto[];
}

/** One secret file; path is repo-relative, never absolute. */
export class SecretFileDto {
  @IsString()
  path!: string;

  @IsString()
  contents!: string;
}

/** Single variable upsert. */
export class SetVarDto {
  @IsString()
  key!: string;

  @IsString()
  value!: string;
}
