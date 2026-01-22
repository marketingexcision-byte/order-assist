-- CreateTable
CREATE TABLE "IngestJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "IngestJob_status_createdAt_idx" ON "IngestJob"("status", "createdAt");
