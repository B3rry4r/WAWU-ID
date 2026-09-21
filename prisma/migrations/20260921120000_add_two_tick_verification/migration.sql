-- The two-tick verification model.
--
-- The five-step ladder (basic / verified_user / verified_business /
-- certified_professional / trusted_partner / official) and Trust Score are
-- gone as product surfaces. What replaces them is two INDEPENDENT paid annual
-- verifications, because one person can hold both roles:
--
--   creator       purple tick   NGN 4,999 / year
--   professional  green tick    NGN 9,999 / year
--
-- Storage is four nullable columns, no enum. Whether a tick draws is DERIVED
-- (verified_at IS NOT NULL AND (verified_until IS NULL OR verified_until >
-- now())), never stored -- a stored boolean is wrong the moment an expiry
-- passes, and this table has no job that runs at midnight.
--
-- EXPAND HALF OF EXPAND/CONTRACT. This migration is additive plus a one-time
-- backfill. It deliberately does NOT drop "verification_tier", "trust_score",
-- or the "VerificationTier" enum: an older instance is still selecting those
-- columns while this deploy rolls, and dropping a column out from under a
-- running SELECT takes the service down. Stop reading them first; the drop is
-- its own migration once nothing deployed selects them.

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN     "creator_verified_at" TIMESTAMP(3),
ADD COLUMN     "creator_verified_until" TIMESTAMP(3),
ADD COLUMN     "professional_verified_at" TIMESTAMP(3),
ADD COLUMN     "professional_verified_until" TIMESTAMP(3);

-- Backfill from the old ladder.
--
-- The four trusted tiers were how the old product said "this account is a
-- vetted professional", so they carry across as the PROFESSIONAL tick, granted
-- perpetually: verified_until stays NULL. These accounts never paid the annual
-- fee, so expiring them a year from a migration would revoke a badge the
-- holder was given and never charged for.
--
-- 'basic' and 'verified_user' carry across as no tick at all: they meant
-- "signed up" and "confirmed an email", neither of which is a verification
-- anyone was vetted or charged for.
--
-- NOBODY receives the creator tick on backfill. A paid creator tick did not
-- exist before this migration, so there is no row that can honestly claim one.
UPDATE "wawu_users"
SET "professional_verified_at" = CURRENT_TIMESTAMP,
    "professional_verified_until" = NULL
WHERE "verification_tier" IN (
    'verified_business',
    'certified_professional',
    'trusted_partner',
    'official'
  )
  AND "professional_verified_at" IS NULL;
