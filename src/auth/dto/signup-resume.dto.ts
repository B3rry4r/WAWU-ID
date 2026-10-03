import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Where a sign-up stands before its phone code: the phone and the sign-up's secret. */
export class SignupResumeDto {
  @ApiProperty({ minLength: 7, maxLength: 25 })
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
