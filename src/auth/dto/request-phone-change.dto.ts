import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * Body for POST /internal/users/:userId/phone/request — step 1 of the verified
 * phone-change flow. `phone` is the new number the user wants to switch to.
 * Uniqueness (no other WAWU user may hold it) is enforced in the service, since
 * it requires a DB lookup; length/format is checked here.
 */
export class RequestPhoneChangeDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(7)
  phone!: string;
}
