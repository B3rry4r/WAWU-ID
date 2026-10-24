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
 * accepted as typed (`0803...` or `+234...`) and stored normalised.
 */
export class SignupDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    minLength: 7,
    maxLength: 25,
    description: 'As typed: 0803..., +234... or 234...',
  })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

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
