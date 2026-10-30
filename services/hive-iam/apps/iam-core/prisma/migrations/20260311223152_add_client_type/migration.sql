-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_clients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "secretHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "clientType" TEXT NOT NULL DEFAULT 'confidential',
    "allowedIps" TEXT NOT NULL DEFAULT '[]',
    "redirectUris" TEXT NOT NULL DEFAULT '[]',
    "grantTypes" TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
    "firstParty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_clients" ("active", "allowedIps", "createdAt", "description", "firstParty", "grantTypes", "id", "name", "redirectUris", "secretHash", "updatedAt") SELECT "active", "allowedIps", "createdAt", "description", "firstParty", "grantTypes", "id", "name", "redirectUris", "secretHash", "updatedAt" FROM "clients";
DROP TABLE "clients";
ALTER TABLE "new_clients" RENAME TO "clients";
CREATE UNIQUE INDEX "clients_name_key" ON "clients"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
