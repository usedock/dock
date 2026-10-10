import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PROVIDER_NAMES } from '../../database/schema';

/** Provider key write payload; service seals the key before storing. */
export class SetProviderKeyDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsIn([...PROVIDER_NAMES])
  provider!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  key!: string;
}

/** Organization scoping for reads and deletes. */
export class ProviderKeysQuery {
  @IsUUID()
  organizationId!: string;
}
