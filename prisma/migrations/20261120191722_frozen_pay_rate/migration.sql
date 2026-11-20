-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "payMode" "PayMode",
ADD COLUMN     "rateCents" INTEGER;

-- Work that was already submitted gets the rate and pay mode its project has
-- today. That is an approximation: what a project paid before this migration
-- was never recorded, so an earlier rate change cannot be recovered.
UPDATE "Assignment" a
SET "rateCents" = p."rateCents", "payMode" = p."payMode"
FROM "Project" p
WHERE p.id = a."projectId" AND a.status = 'SUBMITTED';

-- Accepted work now counts on the day it was reviewed. Rows that have a review
-- status without that date (the demo data was written this way) take the date
-- of their latest review.
UPDATE "Assignment" a
SET "reviewedAt" = r.latest
FROM (
  SELECT "assignmentId", max("createdAt") AS latest FROM "Review" GROUP BY "assignmentId"
) r
WHERE r."assignmentId" = a.id
  AND a."reviewedAt" IS NULL
  AND a."reviewStatus" IN ('APPROVED', 'FIXED', 'SENT_BACK');

-- The pay reports now look work up by the day it was reviewed as well.
-- CreateIndex
CREATE INDEX "Assignment_userId_reviewedAt_idx" ON "Assignment"("userId", "reviewedAt");

-- CreateIndex
CREATE INDEX "Assignment_projectId_reviewedAt_idx" ON "Assignment"("projectId", "reviewedAt");

-- From here on a submission without its rate is refused, whatever writes it.
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_submitted_has_rate"
CHECK ("status" <> 'SUBMITTED' OR ("rateCents" IS NOT NULL AND "payMode" IS NOT NULL));
