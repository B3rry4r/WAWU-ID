import { IsIn, IsOptional, IsString } from 'class-validator';

const ALLOWED_TIERS = [
  'certified_professional',
  'trusted_partner',
  'official',
] as const;

/**
 * Body for PATCH /internal/users/:userId/verification-tier.
 *
 * Accepts either `tier` (the convention used by the WAWUAfrica-API internal
 * client) or `verificationTier`. At least one must be present and valid; the
 * controller resolves whichever is supplied. Downgrades are rejected by the
 * `@IsIn` allow-list (no `basic`/`verified_*`).
 */
export class UpdateVerificationTierDto {
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_TIERS)
  tier?: (typeof ALLOWED_TIERS)[number];

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_TIERS)
  verificationTier?: (typeof ALLOWED_TIERS)[number];
}
