import { IsInt, IsUrl, Max, Min } from 'class-validator';

/**
 * The hub supplies the deadline and where to go to keep the account; this
 * service supplies the address, the name and the wording. Both fields are
 * bounded for the same reason DittoInviteDto bounds its own: a leaked service
 * key must not be able to put an arbitrary link, or an arbitrary claim about
 * how long somebody has, inside a WAWUAfrica-branded email.
 */
export class UnpaidWarningDto {
  /**
   * Hours until deletion. Capped at a week: this is a last warning, and a
   * number outside that range means the caller has miscalculated rather than
   * that the account really has months left.
   */
  @IsInt()
  @Min(1)
  @Max(168)
  hoursLeft!: number;

  @IsUrl({ require_protocol: true, protocols: ['https'] })
  planUrl!: string;
}
