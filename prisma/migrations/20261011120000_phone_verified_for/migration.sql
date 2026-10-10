-- JOIN-03 round 2 (D1): the access token's `phoneVerified` must not outlive the
-- number that was proven.
--
-- `phone_verified_at` says the account once proved a phone. The two internal
-- phone-change routes (PATCH /internal/users/:id/phone, and the request and
-- confirm pair whose code goes to the account's EMAIL) write a new number and
-- leave `phone_verified_at` as it was, so a number nobody texted or checked
-- looked proven. This column records the number `phone_verified_at` was set
-- for. The token says `phoneVerified: true` only while `phone_verified_at` is
-- set AND this column is still the account's `phone` (same number, however it
-- is spelled). Sign-in rules read `phone_verified_at` and do not change.
--
-- Additive: one NULLABLE column and one UPDATE of that new column. No existing
-- column, index, constraint or value is changed, and an older instance
-- running against this schema never reads or writes it.
--
-- Backfill: every account that has `phone_verified_at` gets its CURRENT phone
-- as the number it was proven for. A phone that was changed through the
-- internal routes BEFORE this migration cannot be told apart from one that
-- never changed (the routes left no trace), so those accounts keep vouching
-- for the number they hold today; every change after it is caught.
--
-- Deploy order: this migration first, then the new code (`npm run start:prod`
-- runs `prisma migrate deploy` before starting, so one deploy does both).
--
-- Roll back (nothing reads the column once the new code is gone; the last
-- line removes this migration's record too, so a later deploy applies it
-- again instead of answering "No pending migrations" with the column missing):
--   ALTER TABLE "wawu_users" DROP COLUMN "phone_verified_for";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261011120000_phone_verified_for';

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "phone_verified_for" TEXT;

-- Backfill
UPDATE "wawu_users"
   SET "phone_verified_for" = "phone"
 WHERE "phone_verified_at" IS NOT NULL;
