ALTER TABLE "service_accounts" ADD COLUMN "provisionId" TEXT;
ALTER TABLE "service_accounts" ADD COLUMN "provisionDigest" TEXT;
CREATE UNIQUE INDEX "service_accounts_provisionId_key" ON "service_accounts"("provisionId");
