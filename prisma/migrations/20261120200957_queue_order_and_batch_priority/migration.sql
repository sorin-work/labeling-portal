-- gen_random_bytes and hmac for the queue secret
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "QueueOrder" AS ENUM ('IMPORT', 'SHUFFLED');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "goldEvery" INTEGER,
ADD COLUMN     "queueOrder" "QueueOrder" NOT NULL DEFAULT 'IMPORT';

-- CreateTable
CREATE TABLE "QueueSecret" (
    "projectId" TEXT NOT NULL,
    "secret" TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'::text),

    CONSTRAINT "QueueSecret_pkey" PRIMARY KEY ("projectId")
);

-- AddForeignKey
ALTER TABLE "QueueSecret" ADD CONSTRAINT "QueueSecret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- every project that exists gets a secret of its own; new ones get theirs on the first claim
INSERT INTO "QueueSecret" ("projectId") SELECT id FROM "Project";

-- DropIndex: covered by the two below
DROP INDEX "Task_batchId_status_idx";

-- CreateIndex
CREATE INDEX "Task_batchId_status_position_idx" ON "Task"("batchId", "status", "position");

-- CreateIndex
CREATE INDEX "Task_batchId_status_isGold_position_idx" ON "Task"("batchId", "status", "isGold", "position");
