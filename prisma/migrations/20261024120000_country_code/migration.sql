-- GEO-01 (R-85): every account has a country of residence.
--
-- `country_code` is ISO 3166-1 alpha-2 in capitals ("NG", "GH"). The older
-- free-text `country` column (what the web types, "Nigeria") is not touched and
-- keeps its meaning; this is the column to filter and group people by.
--
-- Additive: one NULLABLE column, one CHECK on that new column, one UPDATE of
-- that new column. No existing column, index, constraint or value is changed,
-- and an older instance running against this schema never reads or writes it.
--
-- Backfill: an account whose stored phone READS AS a Nigerian number gets 'NG'.
-- "Reads as" is what the service's own lookups mean (comparablePhone in
-- src/common/phone.util.ts): spaces, dashes, dots and brackets are ignored, then
-- +234803..., 00234803..., 234803..., 0803... (and +2340803...) or the ten digits
-- 803... alone. Every other row stays NULL: a phone from another country is not
-- enough to say where the person lives, and a released or erased phone
-- (`released:<id>`, `deleted:<id>`) says nothing at all.
--
-- Deploy order: this migration first, then the new code (`npm run start:prod`
-- runs `prisma migrate deploy` before starting, so one deploy does both).
--
-- Roll back: ./rollback.sql in this folder. It REFUSES (raises, changes
-- nothing) while any account holds a country that this migration's backfill
-- would not produce again, because that country was chosen at sign-up and
-- dropping the column would lose it. Once it has removed the column it also
-- removes this migration's record, so a later deploy applies it again.

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "country_code" VARCHAR(2);

-- A value that is not two capital letters is refused by the database as well.
ALTER TABLE "wawu_users"
  ADD CONSTRAINT "wawu_users_country_code_shape" CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');

-- Backfill
UPDATE "wawu_users"
SET "country_code" = 'NG'
WHERE "country_code" IS NULL
  AND regexp_replace("phone", '[[:space:]().-]', '', 'g')
      ~ '^((\+234|00234|234)0?[789][0-9]{9}|0[789][0-9]{9}|[789][0-9]{9})$';
