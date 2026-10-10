import { ArrayMinSize, IsArray, IsIn, IsString, IsUrl, IsUUID, MaxLength, MinLength } from 'class-validator';
import { WEBHOOK_EVENT_TYPES } from '../../database/schema';

/** Organization scope for endpoint reads. Required: no safe default. */
export class EndpointQuery {
  @IsUUID()
  organizationId!: string;
}

export class CreateEndpointDto extends EndpointQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'url must be an https URL' })
  @MaxLength(2000)
  url!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'events must list at least one event type' })
  @IsIn([...WEBHOOK_EVENT_TYPES], { each: true, message: 'events must be dock lifecycle event types' })
  events!: (typeof WEBHOOK_EVENT_TYPES)[number][];
}
