import { IsEmail, IsIn, IsOptional, IsUUID } from 'class-validator';

/** Member addition by id or email; service requires at least one identifier. */
export class AddMemberDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['owner', 'admin', 'member'])
  role?: 'owner' | 'admin' | 'member';
}

/** Role change payload. */
export class UpdateMemberRoleDto {
  @IsIn(['owner', 'admin', 'member'])
  role!: 'owner' | 'admin' | 'member';
}
