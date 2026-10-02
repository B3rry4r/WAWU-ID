import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PhoneVerifyConfirmDto {
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  /** The secret `POST /auth/signup` returned for this sign-up. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  attempt!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;

  /** The code mailed to the email, when sign-up said `emailCodeRequired`. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'emailCode must be 6 digits' })
  emailCode?: string;
}
