-- CreateEnum
CREATE TYPE "QueueOrder" AS ENUM ('IMPORT', 'SHUFFLED');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "goldEvery" INTEGER,
ADD COLUMN     "queueOrder" "QueueOrder" NOT NULL DEFAULT 'IMPORT';

-- CreateIndex
CREATE INDEX "Task_batchId_status_position_isGold_idx" ON "Task"("batchId", "status", "position", "isGold");
