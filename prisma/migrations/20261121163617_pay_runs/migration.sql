-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "payRunId" TEXT;

-- CreateTable
CREATE TABLE "PayRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT NOT NULL,
    "closedByName" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalCents" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRunLine" (
    "id" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "payMode" "PayMode" NOT NULL,
    "rateCents" INTEGER NOT NULL,
    "tasks" INTEGER NOT NULL,
    "seconds" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "PayRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayRun_orgId_periodStart_idx" ON "PayRun"("orgId", "periodStart");

-- CreateIndex
CREATE INDEX "PayRunLine_payRunId_idx" ON "PayRunLine"("payRunId");

-- CreateIndex
CREATE INDEX "Assignment_payRunId_idx" ON "Assignment"("payRunId");

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A closed pay run and its lines never change. The only removal allowed is
-- the cascade of deleting the whole organisation, as for the audit trail.
CREATE FUNCTION "pay_run_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    IF TG_TABLE_NAME = 'PayRun'
      AND NOT EXISTS (SELECT 1 FROM "Organization" WHERE id = OLD."orgId") THEN
      RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'PayRunLine'
      AND NOT EXISTS (SELECT 1 FROM "PayRun" WHERE id = OLD."payRunId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'a closed pay run cannot be changed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "PayRun_append_only"
BEFORE UPDATE OR DELETE ON "PayRun"
FOR EACH ROW EXECUTE FUNCTION "pay_run_append_only"();

CREATE TRIGGER "PayRunLine_append_only"
BEFORE UPDATE OR DELETE ON "PayRunLine"
FOR EACH ROW EXECUTE FUNCTION "pay_run_append_only"();

-- Work that a run paid keeps what it was paid for: its run, payable date,
-- time, rate and pay mode. Everything else (a gold score, an overturned
-- correction that leaves it accepted) may still change.
CREATE FUNCTION "assignment_paid_is_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."payRunId" IS NOT NULL AND (
    NEW."payRunId" IS DISTINCT FROM OLD."payRunId"
    OR NEW."payableAt" IS DISTINCT FROM OLD."payableAt"
    OR NEW."activeSeconds" IS DISTINCT FROM OLD."activeSeconds"
    OR NEW."rateCents" IS DISTINCT FROM OLD."rateCents"
    OR NEW."payMode" IS DISTINCT FROM OLD."payMode"
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'work in a closed pay run cannot change what it was paid for'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Assignment_paid_is_final"
BEFORE UPDATE ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION "assignment_paid_is_final"();

-- Nothing becomes payable inside a closed period. A payable date on a day
-- that a run of the organisation covers (a resubmission keeping the date of
-- its first submission, say) moves to now, which no run can cover, so the
-- work is paid with the next run. Only past days can be closed, so only a
-- payable date before today needs the look; it takes the organisation's pay
-- run lock shared, which closing takes exclusively, so a close and such a
-- write are never both half done (docs/architecture.md, "Pay runs").
CREATE FUNCTION "assignment_payable_not_in_closed_run"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  org TEXT;
BEGIN
  IF NEW."payableAt" IS NULL OR NEW."payRunId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."payableAt" IS NOT DISTINCT FROM OLD."payableAt" THEN
    RETURN NEW;
  END IF;
  IF NEW."payableAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') THEN
    RETURN NEW;
  END IF;
  SELECT p."orgId" INTO org FROM "Project" p WHERE p.id = NEW."projectId";
  PERFORM pg_advisory_xact_lock_shared(hashtext('pay-run:' || org));
  IF EXISTS (
    SELECT 1 FROM "PayRun" r
    WHERE r."orgId" = org
      AND r."periodStart" <= NEW."payableAt" AND NEW."payableAt" < r."periodEnd"
  ) THEN
    NEW."payableAt" := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Assignment_payable_not_in_closed_run"
BEFORE INSERT OR UPDATE OF "payableAt" ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION "assignment_payable_not_in_closed_run"();

-- TRUNCATE skips row triggers, so it is refused on its own, as for the audit trail.
CREATE FUNCTION "pay_run_no_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a closed pay run cannot be removed' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "PayRun_no_truncate"
BEFORE TRUNCATE ON "PayRun"
FOR EACH STATEMENT EXECUTE FUNCTION "pay_run_no_truncate"();

CREATE TRIGGER "PayRunLine_no_truncate"
BEFORE TRUNCATE ON "PayRunLine"
FOR EACH STATEMENT EXECUTE FUNCTION "pay_run_no_truncate"();
