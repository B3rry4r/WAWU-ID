-- Email verification: confirms ownership of the address a caller registered
-- with. Additive + backward compatible: no existing tables or data touched.

-- AlterTable
ALTER TABLE "wawu_users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "email_verification_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes"("user_id");

-- AddForeignKey
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
