-- DropIndex
DROP INDEX "Assignment_projectId_reviewedAt_idx";

-- DropIndex
DROP INDEX "Assignment_userId_reviewedAt_idx";

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "payableAt" TIMESTAMP(3);

-- The cutover. The pay reports so far counted accepted work on the day it was
-- submitted. Work that is already accepted when this runs keeps that day, so
-- no past period changes and nothing that was paid from an old report is owed
-- a second time. Work accepted from here on is dated by the write that
-- accepts it: the review, or the submission when no review is needed.
UPDATE "Assignment"
SET "payableAt" = "submittedAt"
WHERE "status" = 'SUBMITTED' AND "reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED');

-- CreateIndex
CREATE INDEX "Assignment_userId_payableAt_idx" ON "Assignment"("userId", "payableAt");

-- CreateIndex
CREATE INDEX "Assignment_projectId_payableAt_idx" ON "Assignment"("projectId", "payableAt");

-- Accepted work always has the date it became payable, and nothing else has
-- one: a write that accepts work without dating it would leave it out of every
-- period, and it is refused instead.
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_accepted_has_payable_date"
CHECK (
  COALESCE("status" = 'SUBMITTED' AND "reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED'), false)
  = ("payableAt" IS NOT NULL)
);
