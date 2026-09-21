-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "summary" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT,
    "ip" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policies_slug_version_key" ON "policies"("slug", "version");

-- CreateIndex
CREATE INDEX "policies_slug_published_idx" ON "policies"("slug", "published");

-- CreateIndex
CREATE INDEX "consents_user_id_slug_idx" ON "consents"("user_id", "slug");

-- CreateIndex
CREATE INDEX "consents_slug_version_idx" ON "consents"("slug", "version");

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wawu_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the initial published policy versions (content lives on the web pages).
INSERT INTO "policies" ("id", "slug", "version", "title", "url", "effective_date", "summary", "published")
VALUES
    (gen_random_uuid(), 'privacy', '2026.06.01', 'Privacy Policy, Terms of Use, Data Protection, Consent & Platform Policy', 'https://wawuafrica.com/privacy', '2026-06-01T00:00:00.000Z', 'Initial published version.', true);
