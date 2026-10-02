import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

export class RegisterDto {
  /**
   * The name in three parts, because it has to match a government ID.
   *
   * Sign-up used to take one "Full name" box, split on the first space, and
   * store everything after it as the surname — so "Excel Patrick Obi" got a
   * surname of "Patrick Obi". KYC here is a manual review against a document,
   * and that record does not match the document.
   *
   * `fullName` stays accepted, and optional, because it is not only this web
   * app that registers users — the phone-first WAWUBasket flow and the
   * provisioning importer both send a single name. When the parts are absent
   * it is split as before; when they are present they win.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  middleName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

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

  // Captured by the onboarding form. Stored here too (nullable column) so the
  // sign-up answers survive; the hub profile still keeps its own copy.
  @IsOptional()
  @IsString()
  occupation?: string;

  // 'user' or 'creator'. Optional: the web sign-up does not send it. Any other
  // value is ignored rather than refused, so no request that worked before
  // starts failing.
  @IsOptional()
  @IsString()
  accountType?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
