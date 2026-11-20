-- CreateEnum
CREATE TYPE "GoldChange" AS ENUM ('CREATED', 'EDITED', 'RETIRED', 'RESTORED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "goldFeedback" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "goldRetiredAt" TIMESTAMP(3),
ADD COLUMN     "goldSourceId" TEXT;

-- CreateTable
CREATE TABLE "GoldRevision" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "change" "GoldChange" NOT NULL,
    "previousAnswer" JSONB,
    "answer" JSONB,
    "reason" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoldRevision_taskId_createdAt_idx" ON "GoldRevision"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_goldSourceId_idx" ON "Task"("goldSourceId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goldSourceId_fkey" FOREIGN KEY ("goldSourceId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldRevision" ADD CONSTRAINT "GoldRevision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldRevision" ADD CONSTRAINT "GoldRevision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
