-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "clientId" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "userAgent" TEXT;

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_expiresAt_idx" ON "sessions"("userId", "revokedAt", "expiresAt");
