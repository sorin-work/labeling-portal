-- Stretches of a person's time that have been credited to some piece of work,
-- so the same minutes are never credited twice. Kept by organisation and user.
-- CreateTable
CREATE TABLE "CreditedInterval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditedInterval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditedInterval_orgId_userId_end_idx" ON "CreditedInterval"("orgId", "userId", "end");

-- CreateIndex
CREATE INDEX "CreditedInterval_userId_idx" ON "CreditedInterval"("userId");

-- AddForeignKey
ALTER TABLE "CreditedInterval" ADD CONSTRAINT "CreditedInterval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditedInterval" ADD CONSTRAINT "CreditedInterval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
