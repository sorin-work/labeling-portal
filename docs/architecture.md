# Architecture

labeling-portal is a single React Router 7 app in framework mode: every page is
rendered on the server, and loaders/actions talk to PostgreSQL through Prisma.
There is no separate API service.

```
app/
  domain/      pure TypeScript: schemas, answer validation, consensus,
               agreement (kappa), gold scoring, payouts, import/export
  models/      *.server.ts data access on top of Prisma, one file per area
  lib/         sessions, auth, permissions, formatting, small helpers
  components/  shared UI and the four labeling interfaces
  routes/      route modules (loader + action + component)
prisma/        schema, migrations and the demo seed
tests/unit/         domain logic, no database
tests/integration/  loaders and actions against a real PostgreSQL
```

## Core objects

| Model                  | What it is                                                           |
| ---------------------- | -------------------------------------------------------------------- |
| `Organization`         | A labeling vendor or team. Everything below belongs to one org.      |
| `Membership`           | A user's role in an org: admin, project manager, reviewer, annotator |
| `Project`              | Instructions, a JSON task schema, overlap, time limit, pay rate      |
| `ProjectMember`        | Who may work on or review a project; `qualifiedAt` after the test    |
| `Batch` / `Task`       | Imported rows. Tasks can be gold (honeypots) or qualification items  |
| `Assignment`           | One annotator's claim on a task and, once submitted, their answer    |
| `Review`               | A reviewer's decision on a submission: approve, send back or fix     |
| `QualificationAttempt` | A graded attempt at a project's qualification test                   |
| `Activity`             | What managers did to a project (settings, imports, members, status)  |

## Task lifecycle

1. An annotator presses **Start**. `claimNextTask` releases expired claims,
   then picks the first open task (by import position) that the annotator has
   not done or skipped and that has fewer live claims and submissions than the
   project's overlap. The task row is locked while the claim is created.
2. The claim expires after the project's time limit. In the last two minutes
   the annotator can ask for more time once, which adds another full limit.
   Expired claims are released lazily the next time anyone asks for work in
   that project, and a submission that arrives after the limit is refused.
3. On submit the answer is validated against the schema. Gold tasks are scored
   immediately; other work goes to review (or is accepted straight away when
   the project does not require review).
4. Reviewers approve, send back with feedback, or fix the answer themselves.
   Sent-back work can be revised and resubmitted by the annotator.
5. When `overlap` submissions are accepted the task is complete and the
   accepted answers are merged into a consensus with an agreement score.

## Quality

- **Gold tasks** are mixed into the queue and scored against the known answer.
- **Agreement**: Cohen's kappa per pair of annotators and Fleiss' kappa across
  the project for categorical answers (labels, preferences); span and box F1
  for entities and bounding boxes.
- **Qualification**: a project can require a passed test before claiming work.

## Keeping an eye on things

- The dashboard shows managers a **needs attention** list: submissions waiting
  for review for more than a day and annotators whose gold accuracy is below
  80% after at least three gold tasks.
- Every project has an **activity** tab with settings changes, imports, batch
  deletions, status changes and membership changes.
- Sign-in attempts are rate limited per email (ten failures per fifteen
  minutes, in memory).

## Backups

`docker/backup.sh` runs in the `backup` service of `docker-compose.yml`, in
the same `postgres:17-alpine` image as the database so that `pg_dump` matches
the server. It is a shell loop, not cron. How to use it is in the README
under "Backup and restore"; these are the rules the script keeps, because
breaking one of them loses backups:

- The time in a dump's file name is the only time that counts, for its age
  and for the order of pruning. Modification times are never read.
- The age of the newest dump is read from the names once, at the start.
  After that the loop only remembers when it last made one.
- A dump dated in the future, or with a date that does not exist, is left
  out: it does not say how old the newest dump is, it is never pruned and it
  does not count towards `BACKUP_KEEP`. Sorted by name such dumps would pass
  for the newest ones and push the real dumps out. Every start and every dump
  logs a warning that names them. If every dump is dated in the future the
  loop waits a full interval before its first dump.
- After every attempt, whether it worked or not, the loop pauses before the
  next one, and it waits in steps of a minute with a look at the clock after
  each, so a suspended machine still gets its daily dump.
- `pg_dump` writes to a hidden `.partial` file that is renamed when it is
  complete. A failed or interrupted dump never counts as a backup, and
  pruning never removes the dump that was just written.
- A restore loads the dump into a new database. The swap is one
  transaction: the database in use is renamed aside and the copy takes its
  name. The old one is dropped only after that has committed. So a database
  with the name exists at every moment, which matters because the app
  creates a missing one, empty, when it starts (`prisma migrate deploy`), and
  the loop would then dump that while the real data sat under another name.
  A swap that is refused names the clients that are still connected.

`docker/check-backup-loop.sh` checks the loop, the pruning and the restore
with stand-ins for the database tools, a pretend set of databases and dump
files with made-up dates. `docker/check-backup.sh` runs it and then works on
a real server: it makes dumps, checks that a damaged dump and a restore
while something is connected leave a database with other data alone, then
replaces that database with the newest dump and compares the row counts,
where only the application's tables count as data (Prisma's migrations table
always has rows). CI runs it after the tests, once the demo data is in.

## Pay

Projects pay either per accepted task or per hour of active time. Active time
is measured in the browser (visible tab, recent input) and capped on the server
at the time since the claim.

## Changing the schema once work exists

A project's schema can be edited at any time, but an edit must not orphan or
corrupt work that is already stored. `updateProject` compares the posted
schema with the saved one (`diffSchema` in `app/domain/schema-diff.ts`) and
with what the project's tasks and answers use (`schemaUsage` in
`app/models/projects.server.ts`), in one transaction that holds the project
row. A breaking edit is refused with a 400 and nothing from that post is
saved. The rule lives in the model, so it holds for any form post, not only
for the settings page. The page gets the same counts from its loader and
shows what an edit would do while the manager types.

"Stored answers" are the five places an answer is kept: submissions
(`Assignment.answer`), reviewer corrections (`Review.correctedAnswer`), gold
answers (`Task.goldAnswer`), consensus answers (`Task.consensus`) and
qualification attempts (`QualificationAttempt.answers`).

| Edit                                               | Outcome                                                   |
| -------------------------------------------------- | --------------------------------------------------------- |
| Another kind                                       | Refused once the project has a task or a stored answer    |
| A field name such as `textField` or `imageField`   | Refused once the project has a task                       |
| Add or reorder labels, entity types, box labels    | Saved                                                     |
| Remove or rename a label, entity type or box label | Refused while a stored answer uses the name               |
| `multiple` off                                     | Refused while a stored answer has more than one label     |
| `allowTie` off                                     | Refused while a stored answer is a tie                    |
| Add a rubric dimension                             | Refused while a stored answer with scores has none for it |
| Remove a rubric dimension                          | Saved, with a warning when stored answers have its scores |
| Anything else                                      | Saved                                                     |

- The field names are `textField`, `promptField`, `responseAField`,
  `responseBField` and `imageField`. The imported rows only have the field
  they were imported with.
- A removed rubric dimension leaves its scores on the stored answers. The CSV
  export and new consensus answers leave them out; the JSONL export still
  shows them. The dimension can be added back as long as every answer with
  scores still has one for it.
- "Anything else" is `multiple` or `allowTie` turned on, `minRationaleLength`,
  `minBoxSize`, colours, the label and description of a rubric dimension and
  the order of the dimensions.
- Tasks and answers are separate checks. A draft with imported tasks and no
  answers can still be broken by a field rename, so that is refused too.
- Names are compared exactly, the way answers are validated. A rename, also
  one that only changes case, is a removal plus an addition. There is no
  "rename everywhere" action.
- Nobody can force a refused edit, admins included. The way out for a real
  redesign is **Duplicate project**, which copies the setup into a new draft
  without tasks. The error says so.
- A higher `minRationaleLength` or `minBoxSize` applies from then on. Stored
  answers stay as they are, but a reviewer who fixes an older answer has to
  meet the new minimum.
- A saved schema edit is written to the activity log as
  `detail.changes.schema = [before, after]`. The list of changes is not
  stored: the activity tab runs the diff on the pair again to word the entry.
- The check covers what is stored when the save runs. An answer that was
  validated against the old schema a moment before the save and written a
  moment after it is not caught. Closing that needs every place that stores
  an answer to hold the project row while it validates and writes.

## Adding a labeling kind

Everything kind-specific goes through a `switch (schema.kind)`, so TypeScript
points at every place that needs a new branch once the kind is added to the
schema union:

1. `app/domain/task-schema.ts`: the zod schema, `requiredFields`, a template.
2. `app/domain/answers.ts`: the answer type and its validator.
3. `app/domain/consensus.ts`, `gold.ts`, `agreement.ts`: how answers merge,
   how they are scored against gold, and whether they are categorical.
4. `app/domain/export.ts` and `template.ts`: export columns and example rows.
5. `app/domain/schema-diff.ts`: which edits of the new schema are safe. If its
   answers name labels in a new place, `schemaUsage` in
   `app/models/projects.server.ts` has to count them.
6. `app/components/labeling/`: the interface, wired up in `index.tsx`.
7. A `TaskKind` enum value and a migration.

## Conventions

- Domain code in `app/domain` is pure and has unit tests; it never imports
  Prisma.
- Data access lives in `app/models/*.server.ts`. Route modules call models and
  never build Prisma queries for other areas themselves.
- Every loader and action starts with `requireUser`/`requireRole` and, for
  project pages, `requireProject(current, id, capability)`, which also hides
  other organisations' projects.
- Dates are stored in UTC and shown in UTC.
