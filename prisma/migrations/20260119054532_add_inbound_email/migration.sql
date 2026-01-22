-- CreateTable
CREATE TABLE "InboundEmail" (
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
    CONSTRAINT "InboundEmail_pendingOrderId_fkey" FOREIGN KEY ("pendingOrderId") REFERENCES "PendingOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_messageId_key" ON "InboundEmail"("messageId");
