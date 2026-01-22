-- CreateTable
CREATE TABLE "PendingOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY_FOR_REVIEW',
    "lineItems" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
