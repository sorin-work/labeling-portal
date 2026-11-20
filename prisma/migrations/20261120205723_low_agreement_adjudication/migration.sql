-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'ADJUDICATION';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "agreementThreshold" DOUBLE PRECISION,
ADD COLUMN     "maxExtraAnnotators" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "adjudicatedAt" TIMESTAMP(3),
ADD COLUMN     "adjudicatedById" TEXT,
ADD COLUMN     "adjudicatedNote" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "extraSlots" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Task_projectId_status_escalatedAt_idx" ON "Task"("projectId", "status", "escalatedAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_adjudicatedById_fkey" FOREIGN KEY ("adjudicatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
