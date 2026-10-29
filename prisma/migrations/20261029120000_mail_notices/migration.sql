-- EMAIL-01: POST /internal/mail/notice sends each notice mail once.
--
-- `mail_notices` holds one row per notice mail the Hub asked for, keyed by the
-- Hub's idempotency key. The insert is the claim: of two calls that arrive
-- together with the same key the primary key lets exactly one in, and only
-- that one sends. `status` is 'sending' (claimed, not yet answered for) or
-- 'sent' (the provider took it). The row holds the person's id, the kind and
-- times only: no address, no name, no amount.
--
-- Additive: one new table. No existing table, column, index or constraint is
-- changed, and an older instance running against this schema never reads or
-- writes it. The foreign key cascades, so a hard-deleted account takes its
-- rows with it (an anonymised account keeps the row, which holds nothing
-- personal).
--
-- Deploy order: this migration first, then the new code (`npm run start:prod`
-- runs `prisma migrate deploy` before starting, so one deploy does both).
--
-- Roll back: ./rollback.sql in this folder. It REFUSES (raises, changes
-- nothing) while any row is younger than 7 days, because those rows are what
-- stops a Hub retry from sending a mail twice; once the new code is gone they
-- guard nothing. Once it has dropped the table it also removes this
-- migration's record, so a later deploy applies it again.

-- CreateTable
CREATE TABLE "mail_notices" (
    "idempotency_key" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "provider_id" TEXT,

    CONSTRAINT "mail_notices_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateIndex
CREATE INDEX "mail_notices_user_id_idx" ON "mail_notices"("user_id");

-- CreateIndex
CREATE INDEX "mail_notices_claimed_at_idx" ON "mail_notices"("claimed_at");

-- AddForeignKey
ALTER TABLE "mail_notices" ADD CONSTRAINT "mail_notices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A status the service does not write is refused by the database as well.
ALTER TABLE "mail_notices"
  ADD CONSTRAINT "mail_notices_status_shape" CHECK ("status" IN ('sending', 'sent'));
