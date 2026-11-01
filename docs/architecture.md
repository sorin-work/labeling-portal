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

## Pay

Projects pay either per accepted task or per hour of active time. Active time
is measured in the browser (visible tab, recent input) and capped on the server
at the time since the claim.

## Adding a labeling kind

Everything kind-specific goes through a `switch (schema.kind)`, so TypeScript
points at every place that needs a new branch once the kind is added to the
schema union:

1. `app/domain/task-schema.ts`: the zod schema, `requiredFields`, a template.
2. `app/domain/answers.ts`: the answer type and its validator.
3. `app/domain/consensus.ts`, `gold.ts`, `agreement.ts`: how answers merge,
   how they are scored against gold, and whether they are categorical.
4. `app/domain/export.ts` and `template.ts`: export columns and example rows.
5. `app/components/labeling/`: the interface, wired up in `index.tsx`.
6. A `TaskKind` enum value and a migration.

## Conventions

- Domain code in `app/domain` is pure and has unit tests; it never imports
  Prisma.
- Data access lives in `app/models/*.server.ts`. Route modules call models and
  never build Prisma queries for other areas themselves.
- Every loader and action starts with `requireUser`/`requireRole` and, for
  project pages, `requireProject(current, id, capability)`, which also hides
  other organisations' projects.
- Dates are stored in UTC and shown in UTC.
