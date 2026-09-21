import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  VERIFICATION_TICKS,
  type VerificationTickName,
} from '../../common/verification.util';

/**
 * Body for PATCH /internal/users/:userId/verification.
 *
 * One call grants or revokes ONE tick. The two ticks are independent, so
 * there is deliberately no "set both" shape: a caller that wants both sends
 * two requests and each one is separately auditable.
 *
 * `granted: true`  -> the tick is held until `expiresAt` (omit or send null
 *                     for a perpetual, admin-granted tick).
 * `granted: false` -> the tick is cleared. Both columns go back to NULL, so
 *                     the row reads as un-verified rather than as expired.
 *
 * Note what is NOT here: a `verified` boolean. Whether a tick draws is derived
 * from the expiry on every read, so a caller cannot assert it directly.
 */
export class UpdateVerificationDto {
  /** Which tick: 'creator' (purple) or 'professional' (green). */
  @IsString()
  @IsIn(VERIFICATION_TICKS)
  tick!: VerificationTickName;

  /** true grants or renews the tick, false revokes it. */
  @IsBoolean()
  granted!: boolean;

  /**
   * ISO 8601 expiry. Both verifications are annual, so a grant normally
   * carries one; null or omitted means perpetual, which is how a
   * grandfathered account reads. Ignored when `granted` is false.
   */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}
