-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "dailyTaskLimit" INTEGER;

-- A claim a manager releases on an hourly project is paid the time its draft
-- saves recorded (`releaseClaim`), so a released claim may carry a payable
-- date, together with the rate it is paid at. Everything else is as before:
-- a payable date exactly on accepted submissions.
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_accepted_has_payable_date";
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_accepted_has_payable_date"
CHECK (
  CASE
    WHEN "status" = 'RELEASED' THEN
      "payableAt" IS NULL OR ("payMode" = 'HOURLY' AND "rateCents" IS NOT NULL)
    ELSE
      COALESCE("status" = 'SUBMITTED' AND "reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED'), false)
      = ("payableAt" IS NOT NULL)
  END
);
