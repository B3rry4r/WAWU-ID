-- Roll back 20261024120000_country_code (GEO-01). Not run by `prisma migrate
-- deploy`; run by hand with psql, in one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback.sql
--
-- It refuses, and changes nothing, while any account holds a country that the
-- migration's own backfill would not give it again: a country chosen at
-- sign-up (or a non-Nigerian one) exists nowhere else, and dropping the column
-- would lose it. Clear or export those first (the message counts them). What
-- the backfill gives, 'NG' for a Nigerian phone, is derived from the phone and
-- is not lost.

DO $$
DECLARE
  kept integer;
BEGIN
  SELECT count(*) INTO kept
  FROM "wawu_users"
  WHERE "country_code" IS NOT NULL
    AND NOT ("country_code" = 'NG' AND "phone" ~ '^(\+234|234|0)[789][0-9]{9}$');
  IF kept > 0 THEN
    RAISE EXCEPTION 'GEO-01 rollback refused: % account(s) hold a country that is not derived from their phone. Export them, then clear country_code on them, and run this again.', kept;
  END IF;
END $$;

ALTER TABLE "wawu_users" DROP CONSTRAINT "wawu_users_country_code_shape";
ALTER TABLE "wawu_users" DROP COLUMN "country_code";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024120000_country_code';
