-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "key" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "doneAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_runAt_idx" ON "Job"("runAt");

-- CreateIndex
CREATE INDEX "Job_key_idx" ON "Job"("key");

-- A suggestion run that was waiting or cut short by a restart before this
-- migration (a batch still PENDING) becomes a job, so nothing has to open its
-- batch page for it to go on.
INSERT INTO "Job" ("id", "kind", "payload", "key", "runAt", "maxAttempts")
SELECT 'mig' || md5("id" || clock_timestamp()::text), 'prelabel', jsonb_build_object('batchId', "id"),
       'prelabel:' || "id", now() AT TIME ZONE 'UTC', 3
FROM "Batch"
WHERE "prelabelState" = 'PENDING';
