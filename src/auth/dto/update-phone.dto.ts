import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/**
 * Body for PATCH /internal/users/:userId/phone.
 *
 * The hub proxies a user's own phone-number correction here. Phone uniqueness
 * (no other WAWU user may hold the same number) is enforced in the service, not
 * by validation, since it requires a DB lookup. Length/format is checked here.
 */
export class UpdatePhoneDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(7)
  phone!: string;
}
