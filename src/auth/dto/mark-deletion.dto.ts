import { IsISO8601, IsOptional } from 'class-validator';

/**
 * The body of `POST /internal/users/:userId/mark-deletion` is optional. An
 * older Hub sends none, and then the 30 days end 30 days after the call. A Hub
 * that sends its own `purgeAfter` makes the two clocks the same; a date that is
 * not within a day of 30 days from now is ignored (a leaked service key must
 * not be able to cut the 30 days short or stretch them, SETTINGS-08).
 */
export class MarkDeletionDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  purgeAfter?: string;
}
