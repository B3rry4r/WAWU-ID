-- Add a nullable gender field to wawu_users.
-- Additive + backward compatible: no existing data is touched; legacy rows
-- keep NULL. Canonical lowercase values are 'male' | 'female' (enforced in
-- the application layer, not the DB, so future values stay easy to evolve).

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "gender" TEXT;
