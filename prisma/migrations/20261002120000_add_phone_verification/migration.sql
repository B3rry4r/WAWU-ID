-- Phone code at sign-up (AUTH-03). Additive and backward compatible: three new
-- NULLABLE columns on wawu_users and three new tables (phone_verifications,
-- phone_guess_budgets, rate_counters). No existing column,
-- index, constraint or row is touched, so an older instance running against
-- this schema keeps working. Rows that existed before keep NULL in all three
-- columns, which login() reads as "not phone-verified" (the old rule applies).
--
-- Roll back (nothing reads these once the new code is gone):
--   DROP TABLE "rate_counters"; DROP TABLE "phone_guess_budgets"; DROP TABLE "phone_verifications";
--   ALTER TABLE "wawu_users" DROP COLUMN "phone_verified_at",
--     DROP COLUMN "occupation", DROP COLUMN "account_type";

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "phone_verified_at" TIMESTAMP(3),
ADD COLUMN "occupation" TEXT,
ADD COLUMN "account_type" TEXT;

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,
    "attempt_hash" TEXT NOT NULL,
    "claim_email" TEXT,
    "email_code_hash" TEXT,
    "signup_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_guess_budgets" (
    "phone" TEXT NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "day_start" TIMESTAMP(3) NOT NULL,
    "day_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_guess_budgets_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "rate_counters" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("scope","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_verifications_attempt_hash_key" ON "phone_verifications"("attempt_hash");

-- CreateIndex
CREATE UNIQUE INDEX "phone_verifications_user_id_key" ON "phone_verifications"("user_id");

-- AddForeignKey
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
