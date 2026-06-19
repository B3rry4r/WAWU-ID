-- Phone-number change via email OTP: pending-request support.
-- Additive + backward compatible: no existing tables or data are touched.

-- CreateTable
CREATE TABLE "phone_change_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "new_phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_change_requests_user_id_idx" ON "phone_change_requests"("user_id");

-- AddForeignKey
ALTER TABLE "phone_change_requests" ADD CONSTRAINT "phone_change_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
