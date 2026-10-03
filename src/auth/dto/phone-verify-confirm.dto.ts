import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PhoneVerifyConfirmDto {
  @ApiProperty({ minLength: 7, maxLength: 25 })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  /** The secret `POST /auth/signup` returned for this sign-up. */
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

  /** The code mailed to the email, when sign-up said `emailCodeRequired`. */
  @ApiPropertyOptional({
    pattern: '^\\d{6}$',
    description: 'Required when sign-up answered `emailCodeRequired: true`.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'emailCode must be 6 digits' })
  emailCode?: string;
}
