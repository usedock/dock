import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Topics the contact form offers, with the label used in the notification subject. */
export const CONTACT_TOPICS = {
  'request-access': 'Request access',
  'pricing-plans': 'Pricing and plans',
  business: 'Business and partnerships',
  'cloud-waitlist': 'Dock Cloud waitlist',
} as const;

export type ContactTopic = keyof typeof CONTACT_TOPICS;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** One message from the marketing contact form. */
export class ContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'name must not be empty' })
  @MaxLength(100)
  name!: string;

  @Transform(trim)
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  company?: string;

  @IsIn(Object.keys(CONTACT_TOPICS), {
    message: `topic must be one of ${Object.keys(CONTACT_TOPICS).join(', ')}`,
  })
  topic!: ContactTopic;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'message must not be empty' })
  @MaxLength(4000)
  message!: string;
}
