-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "fromSuggestion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suggestionUnchanged" BOOLEAN;

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "prelabelNote" TEXT,
ADD COLUMN     "prelabelState" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "prelabel" JSONB;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "suggestion" JSONB,
ADD COLUMN     "suggestionSource" TEXT;
