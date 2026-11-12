-- VOICES-MAIL (V-44): remember which product a person signed up through.
--
-- `signup_app` is 'voices' for a person who registered with app "voices". NULL
-- means Who Made This?, which is every row that exists today, so nothing is
-- backfilled. It only chooses the look and links of an account mail when a
-- request does not name an app.
--
-- Additive: one NULLABLE column and one CHECK on that new column. No existing
-- column, index, constraint or value is changed, and an older instance running
-- against this schema never reads or writes it.
--
-- Deploy order: this migration first, then the new code.
-- Roll back: ./rollback.sql in this folder.

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "signup_app" VARCHAR(16);

ALTER TABLE "wawu_users"
  ADD CONSTRAINT "wawu_users_signup_app_known" CHECK ("signup_app" IS NULL OR "signup_app" IN ('voices'));
