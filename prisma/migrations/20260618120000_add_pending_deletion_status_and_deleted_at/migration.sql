-- Cross-ecosystem account deletion: grace-period support.
-- Additive + backward compatible: existing rows and values are untouched.

-- Add the `pending_deletion` variant to the UserStatus enum (deletion grace period).
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending_deletion';

-- Track when an account entered the deletion grace period (null = not pending).
ALTER TABLE "wawu_users" ADD COLUMN "deleted_at" TIMESTAMP(3);
