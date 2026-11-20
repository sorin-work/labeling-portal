-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "draft" JSONB,
ADD COLUMN     "draftSeconds" INTEGER NOT NULL DEFAULT 0;
