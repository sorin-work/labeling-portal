-- The audit trail. Entries now belong to an organisation, may be about no
-- project, and outlive the account that made them.
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_actorId_fkey";
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_projectId_fkey";

ALTER TABLE "Activity" ADD COLUMN "actorName" TEXT,
ADD COLUMN "orgId" TEXT,
ALTER COLUMN "projectId" DROP NOT NULL,
ALTER COLUMN "actorId" DROP NOT NULL;

-- Every entry so far was about a project and made by a known account.
UPDATE "Activity" a SET "orgId" = p."orgId" FROM "Project" p WHERE p.id = a."projectId";
UPDATE "Activity" a SET "actorName" = u.name FROM "User" u WHERE u.id = a."actorId";

-- Entries about a person carry the name, so they read the same after the
-- account is gone. A gold edit kept the old and new answer as text; entries
-- hold no answers, and the gold task's history has them.
UPDATE "Activity" a SET detail = a.detail || jsonb_build_object('userName', u.name)
FROM "User" u
WHERE jsonb_typeof(a.detail) = 'object' AND u.id = a.detail->>'userId';
UPDATE "Activity" SET detail = detail - 'from' - 'to' WHERE action = 'gold.edited';

ALTER TABLE "Activity" ALTER COLUMN "orgId" SET NOT NULL,
ALTER COLUMN "actorName" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Activity_orgId_createdAt_idx" ON "Activity"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_actorId_idx" ON "Activity"("actorId");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Entries are only ever added. An update may only clear the actor or the
-- project, which is what deleting the account or the project does, and an
-- entry may only go with its organisation (the cascade runs after the
-- organisation row is gone). Anything else is refused, whatever sends it.
CREATE FUNCTION "activity_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "Organization" WHERE id = OLD."orgId") THEN
      RAISE EXCEPTION 'activity entries cannot be removed' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id = OLD.id
    AND NEW."orgId" = OLD."orgId"
    AND NEW."actorName" = OLD."actorName"
    AND NEW.action = OLD.action
    AND NEW.detail IS NOT DISTINCT FROM OLD.detail
    AND NEW."createdAt" = OLD."createdAt"
    AND (NEW."actorId" IS NOT DISTINCT FROM OLD."actorId" OR NEW."actorId" IS NULL)
    AND (NEW."projectId" IS NOT DISTINCT FROM OLD."projectId" OR NEW."projectId" IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity entries cannot be changed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "Activity_append_only"
BEFORE UPDATE OR DELETE ON "Activity"
FOR EACH ROW EXECUTE FUNCTION "activity_append_only"();
