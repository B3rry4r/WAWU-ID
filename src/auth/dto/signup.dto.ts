import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** The Hub's AccountType: `user` is a buyer, `creator` sells. */
export const ACCOUNT_TYPES = ['user', 'creator'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Mobile sign-up: email, phone and password (R-6, no BVN here). The phone is
 * accepted as typed (`0803...` or `+234...`, or any country's number with its
 * `+` and country code, R-85) and stored normalised, in E.164.
 */
export class SignupDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    minLength: 7,
    maxLength: 25,
    description:
      'As typed: 0803..., +234... or 234... for a Nigerian number; for any other country the number with its `+` and country code (`+233 24 123 4567`). Stored and answered in E.164. A number that is not valid for its country is refused (400 PHONE_INVALID).',
  })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 2,
    example: 'GH',
    description:
      "GEO-01 (R-85): the country the person lives in, ISO 3166-1 alpha-2 (the code the Hub's country list gives). Optional so every client that signs up without one keeps working: without it the account gets the phone's own country, else NG. A code that is not a country is refused (400 COUNTRY_INVALID). Also the country a phone typed without a country code is read in first (`07400123456` with `GB` is a UK mobile, `7135551234` with `US` is a US one); a number that is not valid there is read as Nigerian if it can be, so `08037770101` still gives `+2348037770101`. A number written with its `+` or `00` country code is read in that country whatever is sent.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCode?: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 80,
    description:
      'First name (SIGNUP-NAMES, R-82). Optional here so every client that signs up without one keeps working; the app asks for it and sends it.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 80,
    description:
      'Last name (SIGNUP-NAMES, R-82). Optional for the same reason as the first name.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  occupation?: string;

  @ApiPropertyOptional({
    enum: ACCOUNT_TYPES,
    description:
      'The A2 pick: discover is `user`, earn is `creator`. Without it the sequence treats the account as `user`.',
  })
  @IsOptional()
  @IsIn(ACCOUNT_TYPES)
  accountType?: AccountType;
}
