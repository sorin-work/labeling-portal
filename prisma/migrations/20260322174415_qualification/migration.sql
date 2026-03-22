-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "qualificationPassPercent" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "qualificationRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProjectMember" ADD COLUMN     "qualifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "isQualification" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "QualificationAttempt" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scorePercent" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualificationAttempt_projectId_userId_idx" ON "QualificationAttempt"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "QualificationAttempt" ADD CONSTRAINT "QualificationAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationAttempt" ADD CONSTRAINT "QualificationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
