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
| `Dispute`              | An annotator's objection to one review decision, and its outcome     |
| `GoldRevision`         | A change to a gold task: who, when, why, the answer before and after |
| `QueueSecret`          | The key of a project's queue hashes; no page ever gets it            |
| `QualificationAttempt` | A graded attempt at a project's qualification test                   |
| `Activity`             | What managers did to a project (settings, imports, members, status)  |

## Task lifecycle

1. An annotator presses **Start**. `claimNextTask` releases expired claims,
   then picks an open task that the annotator may be given (`eligibleFor`:
   not done or skipped by them, not in a paused batch, fewer live claims and
   submissions than the project's overlap) in the order described in "Which
   task comes next" below. The task row is locked while the claim is created.
2. The claim expires after the project's time limit. In the last two minutes
   the annotator can ask for more time, up to three times per claim
   (`MAX_EXTENSIONS` in `domain/time-limit.ts`), and each time adds another
   full limit. Three leaves room for people who need longer and keeps one
   person from sitting on a task for ever. `extendAssignment` refuses a
   request outside the last two minutes (`inExtendWindow`), so extensions
   cannot be stacked, and only updates the claim as it read it, so two
   requests at once count once. However many extensions a claim got, its
   first submission is credited at most two limits (see "Pay").
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
   resubmitted by the annotator, and always returns to review. Instead of
   revising, the annotator can dispute the decision (see "Disputes" below).
5. When `overlap` submissions (plus any extra slots) are accepted the task is
   complete and the accepted answers are merged into a consensus with an
   agreement score. With an agreement threshold on the project, a task under
   it gets extra annotators and then goes to `ADJUDICATION` instead
   (`decideCompletion` in `domain/adjudication.ts`; see "Low agreement" in
   [quality.md](quality.md)). A task that was adjudicated is left alone.
   `refreshTaskStatus` runs in the transaction that accepted the submission
   and locks the task row before it counts, so acceptances that arrive at the
   same moment are counted one after the other and none is missed.

## Which task comes next

`nextTaskSql` in `models/queue.server.ts` is the whole decision, one
statement that picks the task and locks it (`FOR UPDATE OF t SKIP LOCKED`).
Given the same data, the same annotator and the same secret it returns the
same task, so a reload or a second tab gets the task the first one got. Every
hash in it is an HMAC keyed with the project's queue secret (`QueueSecret`, a
random key per project in a table of its own that no loader reads, made by
the migration for existing projects and on the first claim for new ones). So
nothing an annotator sees, ids, times or which of their tasks were gold, tells
them what comes next. The order:

1. **Gold spacing** (`Project.goldEvery`, empty by default). When it is set,
   each claim is a draw: a gold task is due with a chance of 1 in N
   (`goldDraw`), from an HMAC of the annotator and their latest submission or
   skip. The draw has no memory, so the tasks right after a gold task can be
   gold too and no gap is ever certain; it is new after every task handed in
   or skipped and the same on a reload. Gold is not due for the first task of
   a session (no submission in the project in the last 30 minutes) or someone's
   first task ever; the task after that is an ordinary draw. A cap keeps a
   streak from running away: with 10 gold tasks among the last 5N submissions
   (fewer for N below 3) the next claim is regular. The wanted kind is tried
   first and the other kind second, so the queue serves what is left when
   only gold or no gold remains. Without spacing, gold tasks stay where their
   position puts them, as before.
2. **Batches**: not paused (`Batch.pausedAt`), the highest `Batch.priority`
   first, then in import order (the batch's first position).
3. **Inside a batch**: by position, or with `Project.queueOrder = SHUFFLED`
   by the HMAC of the annotator and the task: the order is the annotator's own
   and stays the same for them.

The levels are nested lateral joins with `LIMIT 1`, so PostgreSQL stops at
the first batch that has an eligible task and only the picked task is locked.
Import order inside a batch uses `Task(batchId, status, position)`, and
with gold spacing, where each kind is looked for on its own,
`Task(batchId, status, isGold, position)`, so a kind that is used up costs
nothing to look for. The batch order uses `Task(batchId, position)`. A
shuffled order has no index: it sorts the open tasks of a batch, one batch at
a time. On a project with 40 batches and 40,000 tasks, 30,000 of them
complete, and an annotator with 2,000 submissions who has done every gold
task, the statement took 8 to 10 ms in import order and 11 to 12 ms shuffled,
with gold spacing off, on, and with gold due on every claim (roadmap item 17
is about larger projects).

Pausing stops new claims at the next request. Claims that exist can be
submitted, and nothing else about the batch changes, so after a resume a task
that has some of its answers gets the rest. A priority change only affects
the next claim. The dashboard count (`countAvailable`) uses the same
`eligibleFor` and so leaves paused batches out too.

After the pick, `claimNextTask` checks `eligibleFor` again on the locked row,
because a slot count taken before the lock may miss a claim that was committed
in between, and retries with a new pick if it fails.

**The slot counter.** `Task.takenSlots` is the number of the task's
assignments that are `ACTIVE` or `SUBMITTED`. A trigger on `Assignment`
(`task_taken_slots`, in the migration `task_taken_slots`) keeps it, in the
statement that inserts, updates or deletes the assignment, so no code path
can forget it and it cannot drift. `eligibleFor` compares it with the overlap
and the extra slots on the task's own row, so a task that is full (waiting for
review, say) is passed over without a query per task. A claim past its time
limit stays counted until it is marked expired, so `claimNextTask` and
`countAvailable` first mark expired claims with the same `now`; after that the
counter is exactly what the old per-task count gave.

**Lock order: the task row before the assignment row.** When an assignment
enters or leaves `ACTIVE`/`SUBMITTED` (a claim, a skip, a release, an expiry,
a deletion), the trigger updates its task's row, which takes that row's
`FOR NO KEY UPDATE` lock. So every transaction that writes an assignment
takes its task row first, with `lockTaskOfAssignment` in `lib/db.server.ts`
(or, for a claim, the pick's `FOR UPDATE`): submit, skip, release, the expiry
of a late submission, a resubmission, a review decision and the overturn of a
dispute. Gold scoring reads the expected answer under that same
`FOR NO KEY UPDATE` lock, not `FOR SHARE`, so a shared lock can never be
upgraded in a circle. Expiry of many claims (`expireClaims`) first locks all
their tasks in id order and only then writes the claims, so two expiries and a
submission cannot cycle either. Writes that never change an assignment's state
and never lock a task (draft saves, extensions, review holds) take only the
assignment row. As a backstop, `retryOnLockConflict` runs the queue's transactions (claim, submit, skip, release, expiry) once more if PostgreSQL still aborts one with a deadlock (40P01) or a serialization failure (40001). The cost: writers of the same task queue on its
row for the moment each takes, including annotators submitting the same gold
task. `tests/integration/lock-order.test.ts` holds the locks from a second
connection and checks the order.

The migration puts the trigger in place and fills the counters in one
statement, with the `Assignment` table locked against writes, so nothing
written while the app runs is missed. To check the counters, or to repair them
after a restore that skipped triggers:

```sql
-- tasks whose counter disagrees with their assignments
SELECT t.id, t."takenSlots", c.n
FROM "Task" t
LEFT JOIN (
  SELECT "taskId", count(*)::int AS n FROM "Assignment"
  WHERE status IN ('ACTIVE', 'SUBMITTED') GROUP BY "taskId"
) c ON c."taskId" = t.id
WHERE t."takenSlots" <> COALESCE(c.n, 0);

-- set them right (run inside BEGIN; LOCK TABLE "Assignment" IN SHARE ROW EXCLUSIVE MODE; ... COMMIT;)
UPDATE "Task" t SET "takenSlots" = COALESCE((
  SELECT count(*)::int FROM "Assignment" a
  WHERE a."taskId" = t.id AND a.status IN ('ACTIVE', 'SUBMITTED')
), 0);
```

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

## Disputes

An annotator who thinks a send-back or a correction is wrong can dispute it
from `/my-work/:assignmentId`, with a reason. Approvals and gold scores cannot
be disputed.

- **Opening** (`openDispute` in `app/models/disputes.server.ts`): only the
  annotator whose work it is, only on the latest decision while the work is
  sent back or fixed, once per decision (`Dispute.reviewId` is unique), and
  only within `Project.disputeWindowDays` of the review (14 by default, 0
  turns disputes off). The dispute keeps a copy of the answer as it stood.
- **Somebody must be there to settle it.** Opening is refused, with a message
  that says so, when nobody but the deciding reviewer and the annotator can
  review in the project (`countResolvers`, by the rule of `requireProject`).
  A dispute that nobody may settle would hold the work for good: unpaid, not
  revisable, its task never complete.
- **Revise or dispute, never both.** Opening a dispute and `resubmitAssignment`
  both start by locking the submission row, so the second one waits and then
  sees what the first did: a revision is refused while a dispute is open, and
  a dispute is refused once the work is back in review. A draft of a revision
  is not saved while a dispute is open either (`saveRevisionDraft`); one that
  was saved before waits for the outcome.
- **Withdrawing** (`withdrawDispute`): the annotator can take their own open
  dispute back. The decision stands and the work is exactly where it was,
  sent back and revisable or fixed. The dispute is kept as `WITHDRAWN`, so
  that decision cannot be disputed a second time.
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
  - an overturned send-back gets `reviewedAt` set to the time of the overturn,
    which is the day the work became payable. An overturned fix was accepted
    and payable since the review, so its `reviewedAt` stays. The pay reports
    go by that date (`payableAt`, see "Pay"), so an overturned send-back shows
    in the period of the overturn, once, and never in the period it was
    submitted in, which may be paid already. A dispute that is upheld or
    withdrawn leaves the work as the review left it and changes nothing that
    is payable;
  - a draft of a revision that was started before the dispute is dropped, so
    approved work never carries one;
  - if the submission is not in the state the decision left it in, the
    transaction throws and nothing is changed.
- **Who reads an overturned review.** `standingReviews` in
  `app/domain/outcome.ts` leaves it out, and with it the quality page
  (reviewed, approval, sent back, QA score), the reviewer's own numbers (which
  get an "overturned" count instead), the corrected answer and the `qa_score`
  in the export. "My work", the revise page and the annotator page show the
  outcome of the dispute in place of the review's feedback and score. The
  histories on the review page and the task page keep the row and mark it.

## Gold tasks

Gold tasks come in with a `_gold` column at import or are made from completed
tasks. `app/models/gold.server.ts` holds everything a manager can do to them;
`docs/quality.md` says what each action means.

- **History.** Every change writes a `GoldRevision` (created, edited, retired,
  restored) with who, when, why and the expected answer before and after, in
  the same transaction as the change, plus an entry for the activity tab that
  describes the answers in words.
- **Edit, then rescore.** `editGoldAnswer` validates with `parseGold`, the
  validator the import uses, and leaves `Assignment.goldScore` alone.
  `previewRescore` and `applyRescore` share one planner (`rescore` and
  `goldImpact` in `app/domain/gold.ts`). A plan has a digest of the expected
  answer, every score change and every annotator's standing before and
  after. The page posts the digest of the plan it showed; `applyRescore`
  plans again under the lock and writes nothing when the digest differs. So
  the button does what the page showed, or nothing. Applying is one
  transaction that only writes `goldScore`.
- **One lock.** Everything that changes a gold task first locks its row
  (`FOR NO KEY UPDATE`). `submitAssignment` scores a gold submission inside
  its own transaction under a shared lock on the same row
  (`scoreGoldSubmission`). So an edit either comes first and is used, or
  waits and is picked up by the rescore: no submission is scored against an
  answer that was replaced while it was being stored.
- **Retired** (`Task.goldRetiredAt`): `eligibleFor` leaves the task out, and
  every place that averages gold scores (quality page, flag, needs attention,
  the annotator's own stats) filters it out. The scores stay.
- **Copies** (`promoteToGold`, `Task.goldSourceId`): a copy takes the data of
  its original, but not its external id, and goes into a batch that still has
  open tasks (chosen by the manager, the most recent by default), at the
  position of one of that batch's open tasks (the random function is a
  parameter, as in `submitAssignment`). Without an open batch nothing is
  copied. An original has one live copy at most: promoting again is refused
  while one is live, and so is bringing back a retired copy while another is
  live; both lock the original, so they cannot pass each other.
- **One item, one group.** `eligibleFor` takes a task, the task it was copied
  from and that task's other copies as one group, and leaves out every task
  of a group in which the annotator has an active claim, a submission or a
  skip. Nobody is handed the same item twice, whichever of them came first.
- **What reaches an annotator.** `goldFeedback` in `app/domain/gold.ts` is the
  only gate for results: nothing before the submission, and afterwards the
  score and the expected answer if the project's `goldFeedback` setting is on,
  the task is not retired and the stored score is the one the current
  expected answer gives (between an edit and its rescore it is not, and
  nothing is shown). The work loader sends nothing about gold and no id of
  the task: no task id, no external id and no id column from the import row
  (`withoutImportId`). It sends `assignmentRef`, a reference cut from the
  assignment's id, which the task page and the batch search resolve.

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
  While the annotator disputes the decision the revise page is read-only, the
  draft route refuses saves and the page sends none and counts no time. When
  the dispute is withdrawn the page's data reloads and saving starts.
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
  the work page, `viewing`, `approving` or `fixing` on the review page. Each
  page names the one mode in which the labeling interface gets its keys. That
  is why `a` is for approving while a reviewer looks at a submission and picks
  response A while they fix it, and why the label keys are off while the skip
  form is open.
- **Keys that commit** (a task, a skip, a review decision) are marked
  `commits` and must name their mode; a unit test walks the table for that.
  Ctrl or Cmd with Enter hands in what the mode is about: the task while
  labeling, the skip while the skip form is open, never the task from the
  skip form. A review decision takes two keys: `a` arms the approval (the
  button and a line under it say so), Enter approves, and Escape or any other
  key calls it off. After a decision the next submission appears on the same
  page, and the keys that decide are ignored until it has been on screen for
  a moment (`DECISION_PAUSE_MS`), so a key that is still held or pressed twice
  cannot decide on work nobody has looked at.
- **Label keys** skip the letters that mean something else somewhere (`a`,
  `e`, `s` on the pages, `f`, `n` and `r` in the box interface), on every
  page, so a label always has the same key. That leaves thirty keys, as many
  as a schema may have labels. `r` joined the list with box editing, so
  labels 24 to 30 moved one letter on: they were `r` to `y` and are now `t`
  to `z`.
- **What is not a shortcut.** Anything with Ctrl, Cmd or Alt belongs to the
  browser and to screen readers; the exceptions are Ctrl or Cmd with Enter and
  with Z, which the browser only uses inside text boxes. A key that is held
  down does not repeat, except the rows marked `repeat` (moving a box with
  the arrows, zooming). What is typed into a text box is text, also `?` and
  Escape while the list of shortcuts is open; only handing in and closing the
  skip form work from there. While the list is open nothing else acts. A
  focused radio button keeps its arrow keys and Space, a button its Enter.
- **Layouts.** A digit is taken as typed. Only when the key did not type a
  digit is the physical key read (`event.code`), which makes the digit row
  work where it needs Shift. The number pad works with Num Lock on. Letters
  and `?` are taken as typed.
- **One press, one action, one interface.** The page, the list and every
  interface on the page listen on `window`. A press that one of them handled
  is not offered to the others. With several interfaces on a page (the
  qualification test) the keys go to one card only: the one that holds the
  focus or was clicked last, anywhere in it. That card is marked, and before
  any card is, the keys do nothing. A key never changes an answer the person
  is not working on.
- **Nothing is thrown away by a slip.** No single letter or digit skips,
  releases, deletes or decides: `s` only opens the skip form, releasing has
  no key, approving takes two keys. Removing a box takes Delete or Backspace
  on a box that was selected first, and undo brings it back. Removing a span
  takes Delete (Backspace is left to text boxes), a span is let go when the
  cursor moves into a text box, and the last removal can be put back with the
  "Undo" next to it or Ctrl+Z.
- **Rows that are only listed.** A row marked `passive` shows up in the list
  of shortcuts but is not handed out by the key map: Tab is the browser's,
  and Space and Escape in the box interface only mean something while the
  pointer is on the picture or dragging.

The hooks are in `app/components/labeling/use-hotkeys.ts` and only listen and
pass on what the key map decides. Pairwise score rows are real radio groups:
one tab stop each, the arrows choose, and a typed digit scores the row that
has focus (or the first empty one) and moves to the next, A then B for each
dimension.

## Accessibility

What a keyboard or screen reader user gets, and where it is checked.

- **Every action has a keyboard path.** Entity spans: Tab to the text, the
  left and right arrows walk it word by word (`wordRanges` in
  `domain/spans.ts`: words, and punctuation marks on their own), Shift with
  an arrow selects one word more or less, Enter marks the selection with the
  active type. These keys only act while the text has focus. Boxes: see
  "Boxes on an image" below; the list under the picture says every box with
  its label and position, and picking one there gives it focus on the
  picture, where the arrows, the label keys and Delete work on it. A box's
  label can also be changed in the list.
- **Radio groups are real radio buttons**: the labels of a single-label
  classification (checkboxes for multi-label), the pairwise preference, the
  pairwise score rows and the reviewer's quality score. One tab stop per
  group, the arrows choose, and the hotkeys still work while one has focus.
  A chosen label or preference also shows a tick, not only a colour.
- **Focus.** After a navigation focus goes to `<main id="main">`
  (`app-layout.tsx`), unless the page put it somewhere itself. After "Submit
  and next" it goes to the next task, and a live region says the task's
  reference and the count for today. The list of shortcuts is a modal
  dialog: focus moves into it, Tab stays inside, and closing it puts focus
  back. The skip form and the armed approval give focus back the same way
  (`use-dialog-focus.ts`), unless the person moved it on themselves. Every
  focusable element shows the `:focus-visible` ring from `app.css`;
  visually hidden radio buttons draw it on their visible part, and a box on
  the picture draws a dashed ring, since SVG shows no outline.
- **What is said aloud.** One live region per interface: the word or words
  under the entity cursor and what was marked or removed; a box added,
  moved, resized, relabelled or removed, undo and redo, the zoom. The
  countdown says the time left at 10, 5 and 1 minutes and when it is up
  (`timeAnnouncement`); two minutes belongs to the warning, which is an
  alert. A draft that could not be saved is said; a save that worked is not.
- **Colour.** Text is at least 4.5:1 on its background. `text-slate-400` is
  gone (2.6:1 on white); hints and meta text use `text-slate-500`, and red
  text is `rose-700`. The chart on the quality page and the gold flag are
  also there in words.
- **Checked by tests.** `tests/dom` runs in jsdom with Testing Library and
  `vitest-axe` (the `dom` project in `vitest.config.ts`): the four
  interfaces, editable and read-only; the work page for every kind; review,
  revise (both modes), qualification test and task page for every kind;
  project settings, quality, payouts and earnings; the list of shortcuts and the skip
  form. Every page renders inside the real app layout, and `tests/dom/axe.ts`
  is the one place where an axe rule may be switched off, each with its
  reason. The only one is `color-contrast`, because jsdom computes no
  colours: `tests/unit/contrast.test.ts` reads Tailwind's palette from the
  theme the stylesheet imports, finds every text colour class in `app/` and
  the background it sits on, in every state the class string names (a
  hover or focus background is checked with the text colour in effect then):
  its own class string first, else a parent background listed for that file,
  else the page and card surfaces. It works the ratios out
  (`domain/contrast.ts`). It also checks the focus ring (3:1) and the text on
  the default entity colours. Small key tests in `tests/dom` cover the
  entity cursor, the radio groups, the shortcut list, the box list and the
  next task.
- **Not checked by machine.** Anything that needs layout: the size of
  targets, reflow at 400% zoom, and the colours a schema gives its entity
  types or what is under a box on an image. Box labels on the picture are
  drawn in the label's colour over the image and cannot be checked; the list
  under the picture is the readable version.

## Boxes on an image

`app/components/labeling/bounding-boxes.tsx` wires the pointer and the keys to
pure code: the geometry in `app/domain/geometry.ts`, undo in
`app/domain/history.ts` and the keys in the key map.

- **Image pixels.** A box is stored in pixels of the image, whatever is on
  screen. The view is `{ zoom, x, y }`: zoom 1 fits the whole image, `x` and
  `y` are the image pixel in the top left corner. `toImage` and `toScreen`
  convert at any zoom and position, and the picture is shown with one CSS
  transform (`viewTransform`). Zoom and position are kept for the session
  under the assignment's id (`viewKey`) and never reach the draft or the
  answer. Coordinates are kept to a tenth of a pixel and inside the image
  (`storedBox`). The component stores every box that way, and `validateBbox`
  and the draft reader compare the minimum size on the same rounded box, so a
  box the interface keeps is never refused or dropped as too small.
- **What a press does** is decided by `hitTest` and `pointerIntent`. The
  handles of the selected box come first. Of the boxes under the pointer the
  smallest wins, so a box inside a larger one can always be reached, and of
  two equally large ones the topmost. A press on a handle resizes, on a box
  moves, on the background draws. With Space held or the middle button it
  moves the view. Handles, lines, labels and the reach of a press are sized
  in screen pixels, whatever the size of the image and the zoom.
- **A drag** starts only after four screen pixels, so a click never moves a
  box. While it lasts the component shows a preview, and the answer changes
  once, when the drag ends, so the draft autosave never sees a half dragged
  box. Escape, a lost pointer (`pointercancel`) and a release more than 24
  pixels outside the picture put the box back; inside that margin it stops
  at the edge. `moveBox` keeps a box inside the image, `resizeBox` flips it
  when a handle is dragged past the opposite side, and neither lets it get
  smaller than the schema's `minBoxSize`. The drag is measured in the view it
  started in, so zooming meanwhile does not make the box jump, and only the
  view keys work while it lasts: a removal or an undo during a drag is
  ignored.
- **Without a pointer.** Every box can take focus, and the box that has focus
  is the selected one, so Tab walks through them. `n` puts a new box in the
  middle of the view. The arrow keys move the focused box by one image pixel,
  with Shift by ten, and after `r` they resize it instead. They only do so
  while a box has focus; elsewhere they scroll the page or move inside a
  radio group as usual. Resizing is a mode and not a second modifier, because
  Alt and Ctrl with the arrows belong to the browser, the system and screen
  readers.
- **Undo and redo** (Ctrl+Z, Ctrl+Shift+Z, and two buttons) step through one
  history for the picture: drawing, moving, resizing, relabelling and removing
  are a step each, a whole drag is one step, and a run of arrow presses on one
  box is one step too. The selection is part of every step, which is why boxes
  need no ids. The history starts over when the answer is replaced from
  outside (a restored draft).
- **Zooming.** The wheel zooms around the pointer, `+` and `-` do the same,
  `f` fits the whole image. On a page where the picture can be edited the
  wheel always zooms. A read-only picture leaves the wheel, and touch, to the
  page until it has been zoomed with a button or a key, so a page with
  several pictures still scrolls.
- **Read-only** is the same component with `readOnly`: it can be zoomed and
  moved around and nothing else. The pointer learns that in `pointerIntent`,
  the keys from the `readOnly` rows of the key map, and `apply` in the
  component is the one gate every change to the boxes has to pass.
- **Touch and pen** use the same pointer events. A picture that can be edited
  or is zoomed sets `touch-action: none`, so a finger draws and moves instead
  of scrolling the page. There is no pinch zoom.

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
  loop waits a full interval before its first dump. The date is checked by
  writing it back as a name: busybox `date` in the postgres image turns
  `2026-02-31` into 3 March instead of refusing it, so a dump whose date does
  not come back as the same name counts as one with a date that does not
  exist.
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
start the count again. Time spent revising work that was sent back is added
to it, within the bounds below, and is kept with the revision draft in the
same way.

- **The rate is frozen at submission.** `submitAssignment` copies the
  project's `rateCents` and `payMode` onto the assignment in the same write
  that stores the answer, and reads them in that transaction while holding
  the project row, so a rate change that commits at the same moment is either
  waited for or seen. Payouts, the earnings page and the payout CSV read
  that copy and never the project, so changing a project's rate changes
  nothing that is already submitted. A revision after a send-back keeps the
  rate of the first submission. A check constraint
  (`Assignment_submitted_has_rate`) refuses a submitted row without the
  copy, so code that writes submissions directly, such as a seed or a test,
  has to set both columns.
- **Work counts on the day it became payable**, and that day is stored:
  `Assignment.payableAt`. The write that accepts the work sets it
  (`payableSince` in `app/domain/payouts.ts` is the rule): the review for work
  a reviewer approved or fixed, the submission for work that needed no review
  (review off, gold tasks, and work the review sample did not draw), and the
  overturn for a send-back that a dispute overturned. Work submitted in March
  and approved in April belongs to April. A check constraint
  (`Assignment_accepted_has_payable_date`) refuses accepted work without the
  date and any other work with one, so no write can accept work and leave it
  out of every period. Work that is waiting for review or was sent back has
  no date: the payouts page counts it as pending by its submission date, and
  the earnings page lists all of it whatever the range.
- **The cutover.** Before the date was stored, the reports counted accepted
  work on the day it was submitted. The migration gives every piece of work
  that is already accepted its submission date, so every period of every past
  report is what it was, and nothing that was paid from an old report is owed
  again. Only work accepted after the upgrade follows the rule above.
- **Revising has no deadline, so its time is bounded by hand**
  (`revisionSeconds` in `app/domain/active-time.ts`, used by the resubmission
  and by the revision draft): never more than the time since the review,
  never more than the project's time limit for one revision, which is what a
  first claim gets, and never more than three time limits for an assignment
  in total, however often it is sent back. Every project has a time limit
  (1 to 480 minutes), so there is always a bound.
- **A person's time is credited once.** Those bounds are per assignment, and
  wall-clock time is one resource per person: three submissions sent back
  together and handed in twenty minutes later hold twenty minutes of work
  between them, and a revision made while a claim is held is not also time
  on the claim. So the stretches of a person's time that have been credited
  are stored (`CreditedInterval`, by organisation and user). `creditTime` in
  `app/domain/active-time.ts` is the one place time is credited, for first
  submissions and revisions alike: a piece of work is credited from its own
  window, its start (the claim, or the review that sent it back) to now,
  minus the stretches already credited, within its own cap. It takes the
  earliest free time of the window, which later-started work could not use,
  so a claim from 09:00 handed in at 09:30 still gets its 25 minutes after a
  revision of 09:10 to 09:15 was handed in first. What it takes is stored,
  and no two credits overlap.
- The submit and resubmit transactions lock the person's membership row
  first, so two submissions of one person are credited one after the other.
  The stretches are written back merged. A credit reaches back as far as the
  longest claim can live (`CREDIT_WINDOW_MS`, which is `MAX_CLAIM_MS`: a time
  limit of at most 480 minutes and three extensions, 32 hours), so no claim
  is cut off; a revision, which has no deadline, is credited only within that
  far back. A first submission is credited at most two time limits
  (`FIRST_SUBMISSION_LIMITS`), however many extensions it got: extensions
  give the time to finish, and the credit stays where it was with one
  extension, so the total of three limits per assignment still holds. Stretches that end before
  that are removed, so the table holds a few rows per person.
- The clock is per organisation and not per project, so the same minutes
  cannot be paid on two projects. A person in two organisations has two
  clocks, and that is intended: the organisations do not see each other's
  work, and each pays for its own. The stretches are kept by organisation
  and user and not on the membership, so removing someone and adding them
  again does not forget what was credited. The revision draft only keeps a
  count; the resubmission credits it.
- **Money is whole cents everywhere.** Amounts are computed per block of
  work, which is one person, project, pay mode and rate, by `amountCents`.
  An hourly block is rounded once, to the nearest cent with half a cent
  going up, in `divideRounded`, which is the only place anything is rounded
  and works on integers. A project whose rate changed shows as two blocks,
  on the pages and in the CSV, and because each block is rounded by itself a
  total can differ by a cent from one computed another way.
- **Who sees what.** `/payouts` is for managers and shows the organisation.
  `/earnings` shows a person their own blocks, computed by the same code as
  their line on `/payouts`. Gold tasks are paid like other tasks, the
  qualification test is not. The portal does not record payments, and the
  earnings page says so: it separates what is payable for the period from
  what is waiting for review and what was sent back.

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

"Stored answers" are the seven places an answer is kept: submissions
(`Assignment.answer`), reviewer corrections (`Review.correctedAnswer`), gold
answers (`Task.goldAnswer`), the expected answers a gold task had before it
was edited (`GoldRevision.previousAnswer`, which its history still shows),
consensus answers (`Task.consensus`), the answer a dispute was about
(`Dispute.answer`, counted only once the submission has been revised and says
something else) and qualification attempts (`QualificationAttempt.answers`).
No answer is counted twice. A correction that a dispute overturned still
counts: the review row is kept and shown. The error names the places, for
example "2 stored answers use it (1 submission, 1 gold answer)", so the
manager knows where to look. An attempt keeps the posted map of answers as it
came, and only the entries of the project's test questions were validated, so
only those count.

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
- The check is not atomic with the code that stores answers. The usage
  count sees what was committed when its statement started. An answer that
  is committed between that snapshot and the commit of the save is not
  counted, and neither is one whose request read the old schema before the
  save committed and stores its answer after it. So the open window is as
  long as the usage statement and the save take together, plus the time a
  submit, review, import or test request needs between reading the project
  and writing. The usage statement unnests every stored answer of the
  project, which is about two seconds at 200,000 tasks. Closing the window
  needs every place that stores an answer to hold the project row while it
  validates and writes.
- The save holds the project row with `FOR NO KEY UPDATE`, the lock an
  `UPDATE` takes anyway. Two saves of one project run one after the other,
  and claims, imports and activity entries, which only point at the row, do
  not wait for a save.

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
   A format of its own for the kind is one more row in `EXPORT_FORMATS`; the
   download route and the export page read that table.
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
