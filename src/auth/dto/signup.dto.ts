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
