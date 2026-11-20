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
| `Assignment`           | An annotator's claim on a task: a draft first, then their answer     |
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
3. On submit the answer is validated against the schema. A text without
   entities or an image without objects is an answer too and is submitted with
   nothing marked. Gold tasks are scored immediately; other work goes to
   review, or is accepted straight away when the project does not require
   review or reviews only a share and the draw left this submission out (see
   "Review sampling" below).
4. Reviewers approve, send back with feedback, or fix the answer themselves.
   A submission is reserved for one reviewer while they look at it (see
   "Reviewer reservations" below). Sent-back work can be revised and
   resubmitted by the annotator, and always returns to review.
5. When `overlap` submissions are accepted the task is complete and the
   accepted answers are merged into a consensus with an agreement score.
   `refreshTaskStatus` runs in the transaction that accepted the submission
   and locks the task row before it counts, so acceptances that arrive at the
   same moment are counted one after the other and none is missed.

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
lasts 15 minutes from the moment it was taken or last renewed
(`app/domain/review-hold.ts`) and then simply stops counting; there is no
background job that clears it.

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
- While the reviewer works, the review page renews the hold every five
  minutes with a POST (`intent=renew`, `renewReviewHold`), but only if the
  tab is visible and was touched since the last check. Starting a fix renews
  it at once, and so does a posted decision that does not validate. So a
  long fix keeps its submission, and a tab that was left open lets it go. A
  renewal only touches a hold that is still the reviewer's own.

## Drafts

An answer in progress would otherwise live only in the browser tab. The work
page therefore saves it to the assignment (`draft`, with the working time in
`draftSeconds`) two seconds after the last change, at least every ten seconds
while changes keep coming, when the tab is hidden or closed, and when the
annotator leaves the page inside the app. Working time alone is saved every
thirty seconds. After a reload the page starts from the draft and the working
time counts on from the saved value.

- A draft is not a valid answer (a comparison without a preference yet), so it
  is stored without `validateAnswer` and only checked for size. Submitting
  validates as before. When a draft is read back, `fitDraft` in
  `app/domain/drafts.ts` keeps what still fits the task schema and drops the
  rest: unknown labels, spans outside the text, boxes outside the image or
  under `minBoxSize`. A stored draft therefore cannot break the page or block
  the submit after a schema change, and the page says how many parts were
  left out.
- The draft ends with the claim: submitting, skipping, releasing and running
  out of time all clear it.
- The same task in two tabs: the last save wins, and only the submit counts.
  A tab that was only looked at sends no answer, so it cannot overwrite the
  draft of the tab that was worked in. The saved working time never goes down
  (`GREATEST` in the one statement that writes it).
- Saving pauses only while the page's own submit, skip or release is on its
  way. If that hand-in fails, saving goes on. Leaving through a link saves on
  the way out, and the sign-out button saves before its own request is sent,
  while the session is still there.
- Revising sent-back work keeps its draft in the same column. That assignment
  is `SUBMITTED`, so the guard is "sent back", and resubmitting clears it.
- The qualification test has no row to keep a draft on. Its answers stay in
  `sessionStorage`, tagged with the attempt they belong to.
- A reload is faster than the save the closing page sends, so the new page
  would read the draft from before it. The closing page therefore also leaves
  what the server has not confirmed in `sessionStorage`, and the next page
  takes it from there. What can still be lost is the last couple of seconds
  before a crash (up to ten while typing without a pause).
- Everything in `sessionStorage` is filed under the user's id and names the
  user inside, and a copy that belongs to someone else is not read. Signing
  out removes all of it, and handing in the qualification test removes that
  test's answers. Nothing waits for the next person on a shared computer.
- The save is a plain `fetch` to a small resource route (see
  [routes](routes.md)), not a fetcher. A fetcher whose request fails puts the
  error page in place of the task, and the unsaved answer would go with it.
  React Router checks the origin of page actions but not of resource routes,
  so these two routes do it themselves (`requireSameOrigin`).
- The work page and the revise page are rendered under a key (the assignment
  id). "Submit and next" and the browser's back button stay on the same
  route, and without the key React would keep the previous task's answer and
  seconds and save them as the next task's draft.

## Keyboard shortcuts

Every shortcut is a row in one key map, `app/domain/hotkeys.ts`: the keys of
the work page and the review page (`PAGES`), the keys of each labeling
interface (`INTERFACE_KEYS`) and the label keys (`1` to `9`, `0` for the
tenth, then letters). The key handlers, the list behind `?` and the hints
next to buttons are all made from these tables, so they cannot drift apart.
A new shortcut is added there first; the unit tests fail when a key gets two
meanings on one page.

- **Modes.** A page key can be limited to a mode: `labeling` or `skipping` on
  the work page, `viewing` or `fixing` on the review page. Each page names the
  one mode in which the labeling interface gets its keys. That is why `a`
  approves while a reviewer looks at a submission and picks response A while
  they fix it, and why the label keys are off while the skip form is open.
- **Label keys** skip the letters that mean something else somewhere (`a`,
  `e`, `s` on the pages, `f` and `n` kept for the box interface), on every
  page, so a label always has the same key.
- **What is not a shortcut.** Anything with Ctrl, Cmd or Alt belongs to the
  browser and to screen readers; only Ctrl or Cmd with Enter submits. A key
  that is held down does not repeat. Nothing acts while the cursor is in a
  text box (except submit and closing the skip form) or while the list of
  shortcuts is open. A focused radio button keeps its arrow keys and Space,
  a button its Enter.
- **Layouts.** Digits are read from the physical key (`event.code`), so the
  digit row works where it needs Shift, and the number pad works with Num
  Lock on. Letters and `?` are taken as typed.
- **One press, one action, one interface.** The page, the list and every
  interface on the page listen on `window`. A press that one of them handled
  is not offered to the others, and with several interfaces on a page (the
  qualification test) the keys go to the one that was used last.
- **Nothing is thrown away by a slip.** No single letter or digit skips,
  releases or deletes: `s` only opens the skip form, releasing has no key, and
  removing a box or a span takes Delete or Backspace on something that was
  selected first.

The hooks are in `app/components/labeling/use-hotkeys.ts` and only listen and
pass on what the key map decides. Pairwise score rows are real radio groups:
one tab stop each, the arrows choose, and a typed digit scores the row that
has focus (or the first empty one) and moves to the next, A then B for each
dimension.

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
at the time since the claim. It is saved with the draft, so a reload does not
start the count again.

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
2. `app/domain/answers.ts`: the answer type and its validator, and
   `app/domain/drafts.ts`: how an unfinished answer is read back.
3. `app/domain/consensus.ts`, `gold.ts`, `agreement.ts`: how answers merge,
   how they are scored against gold, and whether they are categorical.
4. `app/domain/export.ts` and `template.ts`: export columns and example rows.
5. `app/domain/schema-diff.ts`: which edits of the new schema are safe. If its
   answers name labels in a new place, `schemaUsage` in
   `app/models/projects.server.ts` has to count them.
6. `app/components/labeling/`: the interface, wired up in `index.tsx`.
7. `app/domain/hotkeys.ts`: its keys in `INTERFACE_KEYS`, and how many label
   keys it needs.
8. A `TaskKind` enum value and a migration.

## Conventions

- Domain code in `app/domain` is pure and has unit tests; it never imports
  Prisma.
- Data access lives in `app/models/*.server.ts`. Route modules call models and
  never build Prisma queries for other areas themselves.
- Every loader and action starts with `requireUser`/`requireRole` and, for
  project pages, `requireProject(current, id, capability)`, which also hides
  other organisations' projects.
- Dates are stored in UTC and shown in UTC. In raw SQL a date goes through
  `utc()` from `app/lib/db.server.ts`: a bare `${date}` is converted to the
  database session's time zone, which is wrong unless that is UTC.
- A write that ends a claim or decides a submission states the status it
  expects in its `where` and checks how many rows it changed. A form posted
  twice, or two people acting at once, then cannot undo each other.
