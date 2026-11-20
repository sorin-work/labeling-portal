-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "extensions" INTEGER NOT NULL DEFAULT 0;

-- a claim that was extended before this counts as extended once
UPDATE "Assignment" SET "extensions" = 1 WHERE "extendedAt" IS NOT NULL;
