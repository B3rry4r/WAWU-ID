-- The sign-up sequence (AUTH-05). Additive and backward compatible: two new
-- tables, nothing else. No existing table, column, index, constraint or row is
-- touched, so an older instance running against this schema keeps working
-- (it never reads or writes them).
--
--   signup_progress     where a mobile sign-up stands after its phone code
--   signup_email_codes  the code mailed to a signed-in mobile account to prove
--                       its email (hashed; the address only as a sha256)
--
-- Roll back (nothing reads these once the new code is gone):
--   DROP TABLE "signup_email_codes"; DROP TABLE "signup_progress";

-- CreateTable
CREATE TABLE "signup_progress" (
    "user_id" UUID NOT NULL,
    "email_skipped_at" TIMESTAMP(3),
    "creator_setup_at" TIMESTAMP(3),
    "interests_at" TIMESTAMP(3),
    "follows_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signup_progress_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "signup_email_codes" (
    "user_id" UUID NOT NULL,
    "email_hash" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_email_codes_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "signup_progress" ADD CONSTRAINT "signup_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_email_codes" ADD CONSTRAINT "signup_email_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

