-- CreateEnum
CREATE TYPE "PayMode" AS ENUM ('PER_TASK', 'HOURLY');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "payMode" "PayMode" NOT NULL DEFAULT 'PER_TASK',
ADD COLUMN     "rateCents" INTEGER NOT NULL DEFAULT 0;
