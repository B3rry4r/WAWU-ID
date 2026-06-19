import { IsNotEmpty, IsString, Length } from 'class-validator';

/**
 * Body for POST /internal/users/:userId/phone/confirm — step 2 of the verified
 * phone-change flow. `code` is the 6-digit OTP emailed to the user in step 1.
 */
export class ConfirmPhoneChangeDto {
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  code!: string;
}
