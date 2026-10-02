import { IsString, MaxLength, MinLength } from 'class-validator';

export class PhoneVerifyStartDto {
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  /** The secret `POST /auth/signup` returned for this sign-up. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  attempt!: string;
}
