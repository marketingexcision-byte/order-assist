-- CreateTable
CREATE TABLE "CustomerMailbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailAddress" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "label" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InboundEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "receivedAt" DATETIME,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "attachments" JSONB,
    "aiExtracted" JSONB,
    "aiError" TEXT,
    "pendingOrderId" TEXT,
    "customerMailboxId" TEXT,
    CONSTRAINT "InboundEmail_pendingOrderId_fkey" FOREIGN KEY ("pendingOrderId") REFERENCES "PendingOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InboundEmail_customerMailboxId_fkey" FOREIGN KEY ("customerMailboxId") REFERENCES "CustomerMailbox" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_InboundEmail" ("aiError", "aiExtracted", "attachments", "createdAt", "from", "htmlBody", "id", "messageId", "pendingOrderId", "receivedAt", "subject", "textBody", "to") SELECT "aiError", "aiExtracted", "attachments", "createdAt", "from", "htmlBody", "id", "messageId", "pendingOrderId", "receivedAt", "subject", "textBody", "to" FROM "InboundEmail";
DROP TABLE "InboundEmail";
ALTER TABLE "new_InboundEmail" RENAME TO "InboundEmail";
CREATE UNIQUE INDEX "InboundEmail_messageId_key" ON "InboundEmail"("messageId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMailbox_emailAddress_key" ON "CustomerMailbox"("emailAddress");
