import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { NOTIFICATION_ALERT_TYPES } from '../../database/schema';

/** Inbox page window. Cursor is opaque; limit clamps server-side. */
export class InboxQuery {
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

export class PreferencesQuery {
  @IsUUID()
  organizationId!: string;
}

export class UpdateOrgPreferenceDto {
  @IsUUID()
  organizationId!: string;

  @IsIn([...NOTIFICATION_ALERT_TYPES], { message: 'type must be a known alert type' })
  type!: (typeof NOTIFICATION_ALERT_TYPES)[number];

  @IsBoolean()
  enabled!: boolean;
}

export class UpdatePersonalPreferenceDto {
  @IsIn([...NOTIFICATION_ALERT_TYPES], { message: 'type must be a known alert type' })
  type!: (typeof NOTIFICATION_ALERT_TYPES)[number];

  @IsBoolean()
  emailEnabled!: boolean;
}
