-- AlterTable
ALTER TABLE "IngestJob" ADD COLUMN "error" TEXT;
ALTER TABLE "IngestJob" ADD COLUMN "finishedAt" DATETIME;
ALTER TABLE "IngestJob" ADD COLUMN "pendingOrderId" TEXT;

-- CreateIndex
CREATE INDEX "IngestJob_requestId_idx" ON "IngestJob"("requestId");
