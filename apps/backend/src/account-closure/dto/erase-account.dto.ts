import { IsOptional, IsString } from 'class-validator';

export class EraseAccountDto {
  @IsOptional()
  @IsString()
  confirmation?: string;
}
