-- AlterTable
-- Up to when a person's working time has been credited. Time for their next
-- submission or revision counts from here, so the same minutes are never
-- credited on two pieces of work. Empty until the first credit after this.
ALTER TABLE "Membership" ADD COLUMN     "creditedUntil" TIMESTAMP(3);
