-- Roll back 20261029120000_mail_notices (EMAIL-01). Not run by `prisma migrate
-- deploy`; run by hand with psql, in one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f rollback.sql
--
-- It refuses, and changes nothing, while any row is younger than 7 days: those
-- rows are what makes a retry from the Hub answer "replayed" instead of
-- sending the mail a second time, and dropping the table would lose them. Wait
-- until they are 7 days old, or, if the new code is already gone and nothing
-- can retry, clear them yourself first:
--   DELETE FROM mail_notices WHERE claimed_at > now() - interval '7 days';
-- A row older than 7 days guards nothing and is dropped with the table.

DO $$
DECLARE
  guarding integer;
BEGIN
  SELECT count(*) INTO guarding
  FROM "mail_notices"
  WHERE "claimed_at" > now() - interval '7 days';
  IF guarding > 0 THEN
    RAISE EXCEPTION 'EMAIL-01 rollback refused: % notice row(s) are younger than 7 days and still stop a retry from sending twice. Wait, or delete them by hand once nothing can retry, and run this again.', guarding;
  END IF;
END $$;

DROP TABLE "mail_notices";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261029120000_mail_notices';
