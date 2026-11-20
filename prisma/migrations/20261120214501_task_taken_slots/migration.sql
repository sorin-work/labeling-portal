-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "takenSlots" INTEGER NOT NULL DEFAULT 0;

-- kept up to date in the statement that writes the assignment, whatever writes it
CREATE FUNCTION "task_taken_slots"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was_taken boolean := TG_OP <> 'INSERT' AND OLD.status IN ('ACTIVE', 'SUBMITTED');
  is_taken boolean := TG_OP <> 'DELETE' AND NEW.status IN ('ACTIVE', 'SUBMITTED');
BEGIN
  IF was_taken AND (NOT is_taken OR OLD."taskId" <> NEW."taskId") THEN
    UPDATE "Task" SET "takenSlots" = "takenSlots" - 1 WHERE id = OLD."taskId";
  END IF;
  IF is_taken AND (NOT was_taken OR OLD."taskId" <> NEW."taskId") THEN
    UPDATE "Task" SET "takenSlots" = "takenSlots" + 1 WHERE id = NEW."taskId";
  END IF;
  RETURN NULL;
END
$$;

-- One statement, so one transaction: assignments are locked against writes,
-- the trigger is put in place, and the counters are filled from the rows as
-- they are. Nothing written while the app keeps running can fall between the
-- count and the trigger.
DO $$
BEGIN
  LOCK TABLE "Assignment" IN SHARE ROW EXCLUSIVE MODE;
  CREATE TRIGGER "Assignment_taken_slots"
  AFTER INSERT OR DELETE OR UPDATE OF status, "taskId" ON "Assignment"
  FOR EACH ROW EXECUTE FUNCTION "task_taken_slots"();
  -- what the queue used to count per candidate: claims and submissions
  UPDATE "Task" t SET "takenSlots" = c.n
  FROM (
    SELECT "taskId", count(*)::int AS n FROM "Assignment"
    WHERE status IN ('ACTIVE', 'SUBMITTED')
    GROUP BY "taskId"
  ) c
  WHERE t.id = c."taskId";
END
$$;
