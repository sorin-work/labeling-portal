-- CreateEnum
CREATE TYPE "ReviewSample" AS ENUM ('NEW_ANNOTATOR', 'FLAGGED', 'DRAWN', 'NOT_DRAWN');

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "reviewHeldAt" TIMESTAMP(3),
ADD COLUMN     "reviewHeldById" TEXT,
ADD COLUMN     "reviewSample" "ReviewSample";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "reviewSamplePercent" INTEGER NOT NULL DEFAULT 100;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_reviewHeldById_fkey" FOREIGN KEY ("reviewHeldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
