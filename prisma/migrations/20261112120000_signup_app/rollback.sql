-- Roll back 20261112120000_signup_app (VOICES-MAIL). Not run by `prisma migrate
-- deploy`; run by hand with psql, in one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback.sql
--
-- It refuses, and changes nothing, while any account holds 'voices': that is
-- the only record of which product the person signed up through, and dropping
-- the column would lose it. Export those accounts first (the message counts
-- them), clear the column on them, and run this again.

DO $$
DECLARE
  kept integer;
BEGIN
  SELECT count(*) INTO kept FROM "wawu_users" WHERE "signup_app" IS NOT NULL;
  IF kept > 0 THEN
    RAISE EXCEPTION 'VOICES-MAIL rollback refused: % account(s) hold a sign-up app. Export them, clear signup_app on them, and run this again.', kept;
  END IF;
END $$;

ALTER TABLE "wawu_users" DROP CONSTRAINT "wawu_users_signup_app_known";
ALTER TABLE "wawu_users" DROP COLUMN "signup_app";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261112120000_signup_app';
