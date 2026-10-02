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
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  occupation?: string;

  @IsOptional()
  @IsIn(ACCOUNT_TYPES)
  accountType?: AccountType;
}
