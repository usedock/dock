import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ImportDockDto {
  @IsUUID()
  workspaceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @ApiProperty({ required: false, description: 'Unique per workspace; generated when omitted' })
  name?: string;

  @IsString()
  @ApiProperty({ description: 'The Dockyard image the disk was built from (a name from GET /v1/images)' })
  image!: string;

  @IsInt()
  @Min(1)
  @Max(64)
  cpus!: number;

  @IsInt()
  @Min(512)
  @Max(262144)
  memoryMiB!: number;

  @IsInt()
  @Min(1)
  @Max(2048)
  diskGiB!: number;

  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Size in bytes of the zstd-compressed raw ext4 disk (rootfs.ext4.zst); at most diskGiB GiB' })
  sizeBytes!: number;

  @Matches(/^[0-9a-f]{64}$/)
  @ApiProperty({ description: 'Lowercase hex sha256 of the same compressed file' })
  sha256!: string;
}

export class UploadedPartDto {
  @IsInt()
  @Min(1)
  number!: number;

  @IsString()
  @MaxLength(200)
  etag!: string;
}

export class CompleteImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts!: UploadedPartDto[];
}
