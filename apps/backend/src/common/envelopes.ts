import { ApiProperty } from '@nestjs/swagger';

/** Failure shape emitted by HttpExceptionFilter: `{ ok: false, code, message }`. */
export class ErrorEnvelopeDto {
  @ApiProperty({ example: false })
  ok!: boolean;

  @ApiProperty({ example: 'validation_error' })
  code!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;
}
