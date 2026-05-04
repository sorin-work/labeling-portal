-- CreateIndex
CREATE INDEX "Assignment_userId_submittedAt_idx" ON "Assignment"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "Assignment_projectId_submittedAt_idx" ON "Assignment"("projectId", "submittedAt");
