-- Where a pending sign-up's code was sent (AUTH-07). Additive and backward
-- compatible: one nullable column, nothing else. NULL means "texted to the
-- phone", which is every row that exists today, so an older instance running
-- against this schema never reads or writes it and keeps working.
--
-- Roll back (nothing reads the column once the new code is gone). The last
-- line removes this migration's record too, so a later deploy applies it
-- again instead of answering "No pending migrations" with the column missing:
--   ALTER TABLE "phone_verifications" DROP COLUMN "channel";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261006120000_signup_code_channel';

-- AlterTable
ALTER TABLE "phone_verifications" ADD COLUMN "channel" TEXT;
