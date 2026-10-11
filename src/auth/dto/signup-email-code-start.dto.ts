import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Mail another sign-up code: the phone the sign-up stored and its secret. */
export class SignupEmailCodeStartDto {
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
}
