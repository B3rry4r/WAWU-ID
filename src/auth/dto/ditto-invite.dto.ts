import { IsInt, IsUrl, Max, Min } from 'class-validator';

/**
 * The hub supplies the destination and the discount; this service supplies the
 * address, the name and the wording. Both fields are bounded so a leaked
 * service key cannot turn the invite into an arbitrary link in a WAWUAfrica-
 * branded email.
 */
export class DittoInviteDto {
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  signupUrl!: string;

  @IsInt()
  @Min(1)
  @Max(100)
  discountPercent!: number;
}
