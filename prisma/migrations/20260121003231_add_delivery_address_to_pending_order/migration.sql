-- AlterTable
ALTER TABLE "PendingOrder" ADD COLUMN "deliveryAddress" JSONB;
ALTER TABLE "PendingOrder" ADD COLUMN "deliveryAddressSource" TEXT;
