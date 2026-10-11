import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Check the mailed sign-up code: the phone the sign-up stored, its secret, and the 6 digits. */
export class SignupEmailCodeConfirmDto {
  @ApiProperty({
    minLength: 7,
    maxLength: 25,
    description: 'The number as `POST /auth/signup` answered it.',
  })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 200,
    description: 'The secret `POST /auth/signup` returned for this sign-up.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  attempt!: string;

  @ApiProperty({ pattern: '^\\d{6}$' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
