import { IsString, MaxLength, MinLength } from 'class-validator';

/** Key upload payload; the service parses the key and trims the name. */
export class CreateSshKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** One OpenSSH public key line, e.g. the contents of `~/.ssh/id_ed25519.pub`. */
  @IsString()
  @MinLength(1)
  @MaxLength(16384)
  publicKey!: string;
}
