-- SETTINGS-08 (R-17): deleting an account waits 30 days, and signing in during
-- them cancels it.
--
-- `deletion_windows` holds one row per account that is `pending_deletion`: when
-- the 30 days were marked, when they end (`due_at`), and the claim a sign-in
-- takes before it tells the Hub (so two sign-ins together tell it once).
-- `wawu_users.sessions_revoked_at` is the instant before which an access token
-- no longer opens this service's own routes; it is set when the 30 days start
-- and never cleared, so cancelling a deletion does not bring old sessions back.
--
-- Additive: one new table and one NULLABLE column. No existing column, index,
-- constraint or value is changed, and an older instance running against this
-- schema never reads or writes either.
--
-- Deploy order: this migration first, then the new code (`npm run start:prod`
-- runs `prisma migrate deploy` before starting, so one deploy does both).
--
-- Roll back (nothing reads either once the new code is gone; the last line
-- removes this migration's record too, so a later deploy applies it again):
--   DROP TABLE "deletion_windows";
--   ALTER TABLE "wawu_users" DROP COLUMN "sessions_revoked_at";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261017120000_deletion_window';

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "sessions_revoked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "deletion_windows" (
    "user_id" UUID NOT NULL,
    "marked_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "cancel_claim_id" UUID,
    "cancel_claimed_at" TIMESTAMP(3),

    CONSTRAINT "deletion_windows_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "deletion_windows" ADD CONSTRAINT "deletion_windows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
