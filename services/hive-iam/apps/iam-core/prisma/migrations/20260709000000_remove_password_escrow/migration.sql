-- Passwords are one-way credentials. Clear legacy reversible escrow values.
UPDATE "users" SET "encryptedPassword" = NULL WHERE "encryptedPassword" IS NOT NULL;
