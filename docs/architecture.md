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
| `Project`              | Instructions, task schema, overlap, time limit, review share, pay    |
| `ProjectMember`        | Who may work on or review a project; `qualifiedAt` after the test    |
| `Batch` / `Task`       | Imported rows. Tasks can be gold (honeypots) or qualification items  |
| `Assignment`           | One annotator's claim on a task and, once submitted, their answer    |
| `Review`               | A reviewer's decision on a submission: approve, send back or fix     |
| `Dispute`              | An annotator's objection to one review decision, and its outcome     |
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
   immediately; other work goes to review, or is accepted straight away when
   the project does not require review or reviews only a share and the draw
   left this submission out (see "Review sampling" below).
4. Reviewers approve, send back with feedback, or fix the answer themselves.
   A submission is reserved for one reviewer while they look at it (see
   "Reviewer reservations" below). Sent-back work can be revised and
   resubmitted by the annotator, and always returns to review. Instead of
   revising, the annotator can dispute the decision (see "Disputes" below).
5. When `overlap` submissions are accepted the task is complete and the
   accepted answers are merged into a consensus with an agreement score.

## Review sampling

A project with review on has a "Share to review" from 0 to 100
(`Project.reviewSamplePercent`, 100 by default). Below 100 only part of the
work goes to a reviewer:

- `submitAssignment` asks `decideReview` in `app/domain/review-sampling.ts`
  once per submission and stores the outcome in `Assignment.reviewSample`
  (`NEW_ANNOTATOR`, `FLAGGED`, `DRAWN` or `NOT_DRAWN`) next to the
  `reviewStatus` it leads to. Nothing draws again later: pages only read the
  stored value, and the claim is written with a condition on its status, so a
  form posted twice cannot replace the first outcome.
- The random function is a parameter of `submitAssignment`, like `now`. The
  app passes `Math.random`; tests pass a fixed one.
- Until ten of an annotator's submissions in the project have gone to review,
  all of them do. Everything from an annotator the quality page flags for low
  gold accuracy is reviewed too. Only after those two rules does the draw
  decide.
- Work that is not drawn is `NOT_REQUIRED`: accepted at once, counted towards
  the task's overlap and paid like approved work.
- Changing the share affects work submitted afterwards. Work already waiting
  for review stays in the queue.

## Reviewer reservations

Two reviewers must not do the same review. `Assignment.reviewHeldById` and
`reviewHeldAt` say who is on a waiting submission and since when. A hold
lasts 15 minutes (`app/domain/review-hold.ts`) and then simply stops
counting; there is no background job that clears it.

- "Start reviewing" posts to `/projects/:id/review`. `reserveNextReview` in
  `app/models/reviews.server.ts` runs one `UPDATE` whose subquery picks the
  reviewer's current hold or else the oldest free submission with
  `FOR UPDATE SKIP LOCKED`, so reviewers who ask at the same moment get
  different rows. After a decision the next submission is reserved the same
  way.
- A submission opened from the list is read-only until the reviewer presses
  "Review this submission" (`holdReview`). A reviewer keeps one reservation
  per project, so the previous one is let go.
- `recordReview` takes the submission with one conditional write: still
  pending, and not held by someone else. Of two decisions sent at the same
  moment one is stored and the other gets a 409. The same write clears the
  hold.
- Dates in the raw statement are written as UTC explicitly, because a bare
  parameter would be converted to the database session's time zone.

## Disputes

An annotator who thinks a send-back or a correction is wrong can dispute it
from `/my-work/:assignmentId`, with a reason. Approvals and gold scores cannot
be disputed.

- **Opening** (`openDispute` in `app/models/disputes.server.ts`): only the
  annotator whose work it is, only on the latest decision while the work is
  sent back or fixed, once per decision (`Dispute.reviewId` is unique), and
  only within `Project.disputeWindowDays` of the review (14 by default, 0
  turns disputes off). The dispute keeps a copy of the answer as it stood.
- **Revise or dispute, never both.** Opening a dispute and `resubmitAssignment`
  both start by locking the submission row, so the second one waits and then
  sees what the first did: a revision is refused while a dispute is open, and
  a dispute is refused once the work is back in review.
- **Settling** (`resolveDispute`): anyone who can review in the project,
  except the reviewer who made the decision and the annotator who did the
  work, with a note. The rules are checked in the model, not only on the page.
  It is one transaction. The dispute is closed with a write that requires it
  to be open, so of two people settling at once one gets a 409.
- **Upheld** changes nothing but the dispute. The annotator sees the note and
  can revise again.
- **Overturned** takes the decision back in the same transaction:
  - the `Review` row is kept exactly as it was and gets `overturnedAt`;
  - the submission becomes `APPROVED` and `refreshTaskStatus` runs, so the
    consensus is rebuilt from the annotator's own answer (`finalAnswer` skips
    overturned corrections) and the task may complete;
  - an overturned send-back gets `reviewedAt` set to the time of the overturn:
    the work becomes payable now and never in a period that was already paid.
    An overturned fix was accepted and payable since the review, so its
    `reviewedAt` stays;
  - if the submission is not in the state the decision left it in, the
    transaction throws and nothing is changed.
- **Who reads an overturned review.** `standingReviews` in
  `app/domain/outcome.ts` leaves it out, and with it the quality page
  (reviewed, approval, sent back, QA score), the reviewer's own numbers (which
  get an "overturned" count instead), the corrected answer and the `qa_score`
  in the export. "My work", the revise page and the annotator page show the
  outcome of the dispute in place of the review's feedback and score. The
  histories on the review page and the task page keep the row and mark it.

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
