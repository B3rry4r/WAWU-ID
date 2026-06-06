-- Add the `official` variant to the VerificationTier enum.
-- Additive + backward compatible: existing rows and values are untouched.
ALTER TYPE "VerificationTier" ADD VALUE IF NOT EXISTS 'official';
