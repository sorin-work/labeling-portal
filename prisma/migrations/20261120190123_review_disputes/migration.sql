-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "disputeWindowDays" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "overturnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_reviewId_key" ON "Dispute"("reviewId");

-- CreateIndex
CREATE INDEX "Dispute_assignmentId_idx" ON "Dispute"("assignmentId");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
