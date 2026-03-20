-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "goldScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "goldAnswer" JSONB,
ADD COLUMN     "isGold" BOOLEAN NOT NULL DEFAULT false;
