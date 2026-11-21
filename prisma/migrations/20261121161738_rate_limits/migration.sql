-- CreateTable
-- UNLOGGED: the counts need not survive a crash, and the writes stay out of
-- the write-ahead log (and so out of any replica). Prisma cannot say this in
-- the schema; it does not compare it either.
CREATE UNLOGGED TABLE "RateLimitHit" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitHit_expiresAt_idx" ON "RateLimitHit"("expiresAt");


-- CreateIndex
CREATE INDEX "RateLimitHit_name_subject_idx" ON "RateLimitHit"("name", "subject");
