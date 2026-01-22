/*
  Warnings:

  - Made the column `source` on table `IngestJob` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IngestJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "requestId" TEXT,
    "to" TEXT
);
INSERT INTO "new_IngestJob" ("createdAt", "id", "source", "status", "updatedAt") SELECT "createdAt", "id", "source", "status", "updatedAt" FROM "IngestJob";
DROP TABLE "IngestJob";
ALTER TABLE "new_IngestJob" RENAME TO "IngestJob";
CREATE UNIQUE INDEX "IngestJob_requestId_key" ON "IngestJob"("requestId");
CREATE INDEX "IngestJob_status_createdAt_idx" ON "IngestJob"("status", "createdAt");
CREATE INDEX "IngestJob_status_startedAt_idx" ON "IngestJob"("status", "startedAt");
CREATE INDEX "IngestJob_to_idx" ON "IngestJob"("to");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
