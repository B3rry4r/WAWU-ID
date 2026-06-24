import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsString()
  dialCode?: string;

  @IsString()
  @MinLength(1)
  country!: string;

  @IsOptional()
  @IsString()
  state?: string;

  // Nullable, normalized to 'male'|'female' (anything else -> null) on persist.
  @IsOptional()
  @IsString()
  gender?: string;

  // Captured by the onboarding form but stored on the hub profile, not WAWU ID.
  @IsOptional()
  @IsString()
  occupation?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
