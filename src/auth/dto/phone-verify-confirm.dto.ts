import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PhoneVerifyConfirmDto {
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
