-- Refresh tokens are found by id (AUTH-08). Additive and backward compatible:
-- one new NULLABLE column and one unique index on refresh_tokens. No existing
-- column, index, constraint or row is touched, so an older instance running
-- against this schema keeps working (it never reads or writes `jti`).
--
-- Rows that exist now keep NULL in `jti`. Those are the refresh tokens people
-- hold today; the new code still honours them by the old path (a scan limited
-- to unexpired NULL-jti rows) until they expire, 30 days at most. A unique index
-- allows any number of NULLs in Postgres, so the old rows do not collide.
--
-- Deploy order: this migration first, then the new code (`npm run start:prod`
-- runs `prisma migrate deploy` before starting, so one deploy does both).
-- The index build takes a short write lock on refresh_tokens, which is small
-- (one row per live sign-in, pruned as of this change).
--
-- Roll back (nothing reads `jti` once the new code is gone, and the old code
-- finds a token by its hash alone, so every refresh token stays valid whether
-- or not it carries a jti; the rows themselves are not removed). The last
-- line removes this migration's record too, so a later deploy applies it again
-- instead of answering "No pending migrations" with the column missing:
--   DROP INDEX "refresh_tokens_jti_key";
--   ALTER TABLE "refresh_tokens" DROP COLUMN "jti";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007120000_refresh_token_jti';

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "jti" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_jti_key" ON "refresh_tokens"("jti");
