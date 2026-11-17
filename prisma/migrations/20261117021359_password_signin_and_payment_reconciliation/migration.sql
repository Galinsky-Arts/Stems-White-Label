-- CreateEnum
CREATE TYPE "PaymentReconciliation" AS ENUM ('NEEDS_REVIEW', 'REFUND_REQUESTED', 'RESOLVED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "reconciliation" "PaymentReconciliation",
ADD COLUMN     "reconciliationFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationNote" TEXT,
ADD COLUMN     "reconciliationResolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordFromBootstrap" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Order_tenantId_reconciliation_idx" ON "Order"("tenantId", "reconciliation");
