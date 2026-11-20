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

-- A reviewed submission carries the date of its review; the time credited for
-- revising sent-back work is counted from it. Rows that have a review status
-- without that date (the demo data was written this way) take the date of
-- their latest review. Which period work is paid in does not depend on this:
-- the next migration stores that day on its own.
UPDATE "Assignment" a
SET "reviewedAt" = r.latest
FROM (
  SELECT "assignmentId", max("createdAt") AS latest FROM "Review" GROUP BY "assignmentId"
) r
WHERE r."assignmentId" = a.id
  AND a."reviewedAt" IS NULL
  AND a."reviewStatus" IN ('APPROVED', 'FIXED', 'SENT_BACK');

-- From here on a submission without its rate is refused, whatever writes it.
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_submitted_has_rate"
CHECK ("status" <> 'SUBMITTED' OR ("rateCents" IS NOT NULL AND "payMode" IS NOT NULL));
