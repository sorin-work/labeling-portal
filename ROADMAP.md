# Roadmap

Things I might add to labeling-portal. The portal covers the whole loop today
(import, label, review, quality, pay, export), so nothing here is promised or
scheduled. These are ideas, written down with enough detail that I (or anyone
else) can pick one up later without starting from zero. Items may change, move
between groups or be dropped.

What the app does today is in the [README](README.md) and the notes under
[docs/](docs/).

- **Next**: small or well understood. I would start with these.
- **Later**: worth doing, but bigger or waiting on a decision.
- **Maybe**: not sure yet that they are worth the extra complexity.
- **Shipped**: built. The notes at the end say what was built, how it differs
  from the design and what is still open.

Sizes are rough: **S** is an evening or two, **M** a few evenings up to a
couple of weekends, **L** several weeks of spare time.

Each item is meant to fit in one pull request and to be covered by the test
suite. There are no browser tests: `tests/unit` covers the pure code in
`app/domain`, and `tests/integration` calls loaders and actions against
PostgreSQL. So logic worth testing (geometry, key maps, diffs, scoring) belongs
in `app/domain`, not inside a component. Most items add columns, and each
brings its own migration under `prisma/migrations`. File names below are
relative to `app/` unless they start with `prisma/`, `tests/`, `docs/` or
`docker/`.

Items 1 to 18 have shipped. Items from 19 on were written after that, and an
item that improves a shipped one starts by naming it and the open point it
takes up.

"Depends on" lists real prerequisites only. Items that merely touch the same
file are not listed there; the bigger overlaps are mentioned in the items.

## Overview

| #   | Item                                         | Group   | Area          | Size | Depends on |
| --- | -------------------------------------------- | ------- | ------------- | ---- | ---------- |
| 1   | Drafts that survive a reload                 | Shipped | labeling      | S    | -          |
| 2   | Safe schema edits once work exists           | Shipped | projects      | S    | -          |
| 3   | Hotkeys for every action                     | Shipped | labeling      | M    | -          |
| 4   | Review sampling and reviewer reservations    | Shipped | review        | M    | -          |
| 5   | Earnings page and rates frozen at submission | Shipped | payouts       | M    | -          |
| 6   | More import and export formats               | Shipped | import/export | M    | -          |
| 7   | Scheduled backups                            | Shipped | ops           | S    | -          |
| 8   | Accessibility pass                           | Shipped | ui            | M    | -          |
| 9   | Disputes on review decisions                 | Shipped | review        | M    | -          |
| 10  | Gold tasks: add, fix and rescore             | Shipped | quality       | M    | -          |
| 11  | Low-agreement tasks: extras and adjudication | Shipped | quality       | M    | -          |
| 12  | Queue order, batch priority and gold spacing | Shipped | queue         | M    | -          |
| 13  | Moving, resizing and zooming boxes           | Shipped | labeling      | M    | -          |
| 14  | Image classification                         | Shipped | labeling      | M    | -          |
| 15  | Audit trail                                  | Shipped | ops           | M    | -          |
| 16  | API tokens and a JSON API                    | Shipped | api           | L    | -          |
| 17  | Faster on large projects                     | Shipped | performance   | L    | 12         |
| 18  | Pre-labeling hook                            | Shipped | labeling      | L    | -          |
| 19  | Releasing a claim and a daily task limit     | Shipped | queue         | M    | -          |
| 20  | Signing out everywhere                       | Shipped | security      | S    | -          |
| 21  | Spot checks and letting go of a review hold  | Shipped | review        | M    | -          |
| 22  | Taking back the last submission              | Next    | labeling      | M    | -          |
| 23  | Backup status the app can see                | Shipped | ops           | S    | -          |
| 24  | Notifications inside the app                 | Later   | ui            | M    | -          |
| 25  | Marking a pay period as paid                 | Later   | payouts       | M    | -          |
| 26  | Background jobs that survive a restart       | Shipped | ops           | M    | -          |
| 27  | Undo and redo for entity spans               | Later   | labeling      | S    | -          |
| 28  | Two-step sign-in                             | Shipped | security      | M    | 20         |
| 29  | Ranking several responses                    | Later   | labeling      | L    | -          |
| 30  | Webhooks                                     | Later   | api           | L    | 26         |
| 31  | Rate limits shared between processes         | Shipped | security      | S    | -          |
| 32  | Keeping the audit trail for a set time       | Maybe   | ops           | M    | 26         |

## Next

### 22. Taking back the last submission

Improves item 3, which left "submit on pick" out because a slip cannot be
taken back once the next task has loaded. After "Submit and next" the answer
is stored, the time credited (`recordCredit`), a gold task scored, and work
that needs no review may already have completed its task
(`refreshTaskStatus` in `submitAssignment`). The only way to change it is to
wait for a reviewer to send it back.

- The work page shows "Take back the last task" for a short while after a
  submission, say two minutes. Taking it back turns the submission into the
  same state as sent-back work that the annotator revises on
  `/my-work/:assignmentId` (`resubmitAssignment` and the revise draft exist),
  with a marker that the annotator asked for it, not a reviewer.
- Allowed only while nothing downstream has read it: review `PENDING` and
  not held by a reviewer, or `NOT_REQUIRED` on a task that is not complete
  yet. The write states all of that in its `where`, like every other write
  that decides a submission.
- Tricky: gold. With gold feedback on, the annotator has seen the expected
  answer, so a gold task must not be taken back. With feedback off the
  absence of the link would tell gold apart, so there it has to be offered
  like on any other task and the gold score recomputed on resubmit. The rule
  is easier to get right in `domain/` as a pure function of the submission's
  state, with unit tests for every case.
- Tricky: time and pay. The credited interval of the submission stays, and
  revising adds time with the cap item 5 set for revisions. The rate frozen
  at submission stays as well.
- Tricky: review sampling (item 4) was drawn at submission. A taken-back
  submission keeps its draw, or taking back becomes a way to redraw.
- Then "submit on pick" for single-label classification can be a project
  setting, in the same PR or the next one. The label key submits, and the
  take-back is the way out of a slip.
- Undecided: a key. Every free letter is a label key on some project, and
  taking one away changes the keys of existing projects, as `r` did in item 13. I lean towards no key at first.
- Tests: `tests/integration/queue.test.ts` for each allowed and refused
  state, gold with and without feedback, the sampling outcome kept; unit
  tests for the rule.

## Later

### 24. Notifications inside the app

Improves items 9 and 4. Nobody is told anything except through tab counts and
the "My work" page: not about a send-back or a correction, a new dispute, its
outcome, or a rescore that changed a gold score. The app sends no mail and
has no mail service, and adding a hosted one is against how it is run.

- Data: `Notification` (user, organisation, kind, project, link, created,
  read), written in the same transaction as the event, the way `logActivity`
  is. A count of unread ones in `routes/app-layout.tsx` (one indexed count per
  page, `@@index([userId, readAt])`) and a `/notifications` page that marks
  them as read.
- Events: work sent back or fixed (`recordReview`), a dispute opened (to the
  project's managers), a dispute settled (to the annotator and the reviewer
  who decided), a gold rescore that changed your score, a claim released by
  a manager (item 19), and changed instructions (`instructionsUpdatedAt`,
  which the work page already uses for its banner).
- Tricky: gold must not stand out. A rescore notice says the task was gold,
  which is fine only where gold feedback already says so after submitting.
  With feedback off, no notice.
- Tricky: a dispute can be settled by any reviewer of the project except the
  one who decided. Notifying all of them is noise; I lean towards the
  managers only, and the Disputes tab count for reviewers.
- Tricky: the table grows. Read notifications older than 90 days can go; who
  removes them depends on item 26, or on a cleanup when the page is opened.
- Undecided: mail through an SMTP server the owner runs (`SMTP_URL`, off by
  default). Self-hostable and optional, so it fits the rules, but it brings
  bounce handling and unsubscribing. I would leave it to a later item.
- Tests: integration tests that each event writes its notification in the
  same transaction (a refused review writes none), gold without feedback
  writes none, the count, and that nobody reads another person's.

### 25. Marking a pay period as paid

Improves item 5, which says on the page that nothing is marked as paid. The
payouts report is worked out again every time it is opened, and the CSV is
what the owner pays from. Nothing records which CSV was paid, so paying a
period twice, or forgetting a person, is only noticed by hand.

- Data: `PayRun` (organisation, from, to, who closed it, when, total, note)
  and `PayRunLine` (person, project, pay mode, rate, units, amount), copied
  from `payoutReport` when an admin closes the period on `/payouts`. Each
  payable assignment gets `payRunId`, set in the closing transaction with
  `payRunId IS NULL` in the `where`, so no work is in two runs.
- `/earnings` shows each block as paid (with the run's date) or not yet, and
  `/payouts` lists the runs with their CSV, read from the lines, so the file
  of a closed run is the same forever.
- Tricky: the period. Work becomes payable "now" (`payableAt`), so closing a
  period that ends today or later lets new work fall into it after the close.
  Refuse a period that is not over in UTC, and refuse one that overlaps a run.
- Tricky: hourly work is credited by stretches of time (`CreditedInterval`),
  and a revision adds time later. Added time after the close belongs to the
  next run, not to the closed one; that needs the credit to know its own date.
- Tricky: an overturned send-back (item 9) becomes payable at the overturn, so
  it lands in an open period, which is right. Nothing should ever move
  `payableAt` into a closed period; a check constraint or a trigger can say
  so.
- Undecided: reopening a run. I lean towards no, with adjustment lines (an
  amount and a reason, for one person) for mistakes and bonuses.
- Audit entries for closing and for adjustments.
- Tests: `tests/integration/payouts.test.ts`: close, refuse overlap and an
  open period, earnings show paid, no assignment in two runs, revision time
  after the close goes to the next run.

### 27. Undo and redo for entity spans

Improves items 3 and 13, whose notes say that a removed span can be put back
once and that spans do not use the history yet. Boxes have full undo and redo
through `domain/history.ts`. In `components/labeling/ner.tsx` only the last
removed span comes back (the `removed` state), and a wrong type or a span
added by mistake cannot be undone.

- The spans list goes through `domain/history.ts` like the boxes: `Ctrl+Z`,
  `Ctrl+Shift+Z` and buttons, as rows of the key map in `domain/hotkeys.ts`,
  in place of `undoRemove`. The selection travels with each step, as it does
  for boxes.
- Tricky: the word cursor from item 8 and the live region. Each undo says
  what came back or went, as the box interface does.
- Tricky: "Start from the suggestion" (item 18) is a step too, so undo goes
  back to an empty answer, not past it.
- Tricky: the history lives in memory per assignment. A reload starts from
  the draft with no history, the same as boxes; say so in the docs instead of
  storing history in the draft.
- Tests: unit tests in `tests/unit/history.test.ts` with span lists; a DOM
  test for the keys and the announcements, with axe.

### 29. Ranking several responses

A new labeling kind. Pairwise compares two responses. Comparing model output
often needs three to six at once, and doing that in pairs takes n(n-1)/2
tasks whose answers can contradict each other. A `ranking` kind shows a
prompt and several responses, and the annotator puts them in order, with an
optional rubric per response and a rationale.

- Schema: `promptField`, `responseFields` (2 to 6 field names), `allowTies`,
  optional `dimensions` like pairwise, `minRationaleLength`. The answer is an
  ordered list of groups of field names, so a tie is one group.
- It goes through every step of "Adding a labeling kind" in
  `docs/architecture.md`: validation and drafts, consensus (average rank,
  with ties broken by field order), gold scoring (Kendall's tau distance
  scaled to 0 to 1), agreement (`categoricalValue` has to decide; ranks are
  not categories, so I would add Kendall's W instead of kappa), export (JSON
  Lines with the order, and an option that writes each ranking as preference
  pairs, which is what reward model training reads), `schema-diff.ts` (a
  changed response field breaks once tasks exist) and the key map.
- Tricky: ordering without a mouse. Drag and drop alone fails item 8. Number
  keys pick a response, arrows move it, and the live region says the new
  place.
- Tricky: position bias. Show the responses in an order of their own for each
  annotator, from the same HMAC as the shuffled queue (item 12), and store the
  answer by field name, never by position on the screen.
- Tricky: suggestions (item 18). No rule for this kind, but a `_prediction`
  must pass the same validation.
- Undecided: named fields or one array field per task. Named fields fit the
  CSV import; an array fits JSON Lines. I lean towards named fields.
- Tests: unit tests for validation, consensus, gold scoring and W;
  integration tests for import, submit, review and export; a DOM test with
  axe for the interface.

### 30. Webhooks

Improves item 16, whose notes leave webhooks open. A script that wants new
labels has to poll the export or the task lookup. A webhook tells it when a
task is complete or a batch is done.

- Data: `Webhook` (project, address, secret, events, on or off, who made it)
  and the deliveries as jobs of item 26, with a `WebhookDelivery` row per
  attempt (status code, time, error) shown on a project settings tab for
  admins and project managers.
- Events: `task.completed` (with the consensus answer and how it was
  reached) and `batch.completed`. Payloads hold ids, the answer and links to
  the JSON API, never annotator addresses.
- Each request is signed: a header with a time and the HMAC-SHA256 of time
  and body under the webhook's secret, which is shown once like a token.
- Tricky: the server now sends requests to addresses that managers type. Item
  14 kept the server from ever fetching image addresses for this reason.
  Refuse loopback, private and link-local addresses after resolving the name,
  connect to the address that was checked (so a second lookup cannot point
  elsewhere), follow no redirects, and allow internal hosts only through a
  variable like `INTERNAL_IMAGE_HOSTS`.
- Tricky: the job is written in the transaction of the event (an outbox), so
  a rolled-back change sends nothing and a crash after the commit loses
  nothing.
- Retries with a growing delay, a webhook turned off after a day of failures
  with a notice to the person who made it, and a "Send a test" button.
- Undecided: one webhook per project or per organisation. I lean towards per
  project, which follows the permissions that exist.
- Tests: integration tests with a local HTTP server in the test: signature,
  retry, turned off after failures, refused addresses, no delivery from a
  rolled-back transaction.

## Maybe

### 32. Keeping the audit trail for a set time

Improves item 15, whose notes say entries are kept for ever. Every sign-in
and download adds a row, and the trail keeps a person's name after their
account is gone. Some organisations have a rule that such records are kept
for a set time and then removed.

- `auditRetentionDays Int?` on `Organization`, set by admins, empty for ever.
  A daily job (item 26) removes older entries and leaves one entry that says
  how many went and up to which day.
- Tricky: the triggers from item 15 refuse every DELETE, on purpose. A way
  through is a function owned by the database owner that the trigger lets
  pass, for example through a setting that only that function sets. Anyone
  with direct database access could use the same way, so the trail becomes
  weaker than it is today. The docs have to say that plainly.
- Tricky: the project activity tab reads the same table, so a schema's change
  history goes with it.
- Undecided: removing entries or only removing the names in them (the actor
  and the person a change was about). I lean towards offering only the
  second, which keeps the trail whole.
- Tests: integration tests that the job removes only older entries of its own
  organisation, leaves its own entry, and that a plain DELETE is still
  refused.

## Shipped

### 1. Drafts that survive a reload

The work page saves the answer in progress and the working time to the
assignment (`draft`, `draftSeconds`) shortly after each change, when the tab
is hidden or closed and when the page is left, and a reload starts from there.
The page body is keyed by assignment id, so nothing carries over to the next
task. Revising sent-back work keeps a draft in the same column, and the
qualification test keeps its answers in `sessionStorage`. Different from the
design: the save is a plain `fetch` to two resource routes
(`POST /work/:assignmentId/draft`, `POST /my-work/:assignmentId/draft`)
instead of an `intent=draft` branch called through `useFetcher`, because a
fetcher whose request fails puts the error page in place of the task. The two
routes check the origin of the request themselves. A save without a changed
answer carries working time only, so a tab that was only looked at cannot
overwrite the draft. A stored draft is fitted to the task schema when it is
read back, and the page says what was left out. A claim that runs out of time
drops its draft too. Because a reload overtakes the closing page's save, that
page also leaves its unsaved work in `sessionStorage`, filed under the user
and removed on sign-out. The details are in
[docs/architecture.md](docs/architecture.md). Still open: a crash can lose the
last seconds before it; a claim that ran out does not hand its draft to the
next claim of the same task; time spent revising is not counted (item 5); the
reset between tasks has no test until the DOM test setup of item 8.

### 2. Safe schema edits once work exists

`diffSchema` in `domain/schema-diff.ts` lists what an edit changes, and
`updateProject` refuses the save when a change would break stored work: 400
with `errors.schema`, which counts the tasks or answers affected and points to
"Duplicate project". The check and the write share one transaction, with the
counts from `schemaUsage`. The settings form shows the same diff while typing,
and a saved edit is logged as `detail.changes.schema = [before, after]`, which
the activity tab words by running the diff again. Different from the design: a
new rubric dimension is refused only while an answer with scores has none for
it, so a dimension removed by mistake can be put back, and consensus now
averages only the dimensions of the current rubric, so the scores a removed
dimension leaves behind stay out of it. Left out: "rename this label
everywhere" and a forced save for admins. Still open: the check is not atomic
with the code that stores answers. An answer committed after the usage count
took its snapshot, or stored by a request that read the old schema before the
save committed, is not caught. Closing that needs every place that stores an
answer to hold the project row while it validates and writes.

### 3. Hotkeys for every action

`domain/hotkeys.ts` holds the one key map: the keys of the work and review
pages with the mode each is limited to, the keys of every labeling interface,
and the label keys (`1` to `9`, `0`, then the letters without `a`, `e`, `f`,
`n` and `s`, the same on every page). The handlers, the list behind `?` (now
also on the review, revise and qualification pages) and the hints next to
buttons are made from it. Pairwise score rows are real radio groups and typed
digits walk them; entity spans are selected with a click, get another type
with a key and are removed with Delete; `s` opens the skip form; on the review
page `s` goes to the feedback box, `e` starts a fix and Escape cancels it.
`use-hotkeys.ts` stops only for text entry, takes digits as typed and reads
the physical key where a layout needs Shift for them, and lets one press
trigger one action. Different from the design: a digit typed while no score
row has focus goes to the first row without a score, so a rubric can be typed
on a fresh page. On a page with several interfaces (the test) the keys go to
the card that holds the focus or was clicked last, which is marked, and to
none before that, not to "the one used last". Approving by key takes two keys
(`a` arms, Enter approves, anything else calls it off) and waits a moment
after each decision, and Ctrl+Enter in the skip form skips. Not built: "submit
on pick". A slip cannot be taken back once the next task has loaded, so it
waits for a way to reopen the last submission. Fixed on the way: entity and
box tasks can be submitted with nothing marked, and the review page starts
fresh for every submission. Still open: letters follow the typed character,
so they need a Latin layout; the list of shortcuts does not take focus (item
8); a removed span can be put back once, a removed box not at all (item 13).

### 4. Review sampling and reviewer reservations

A project has a "Share to review" (`reviewSamplePercent`, 0 to 100).
`submitAssignment` decides once, with the random function passed in, and
stores the outcome in `Assignment.reviewSample`; work that is not drawn is
accepted at once and can complete its task. New and flagged annotators are
always reviewed, and the quality page shows the reviewed share of each
annotator's work. "Start reviewing" is a POST that reserves the oldest free
submission in one statement with `FOR UPDATE SKIP LOCKED`, holds lapse after
15 minutes unless the review page renews them, which it does while the
reviewer works, and a decision is one conditional write. Different from the
design: the outcome of the draw has its own column, the first-ten rule counts
submissions that went to review (work done while review was off does not use
it up), a submission opened from the list is reserved with a button before
the form appears, and deciding on a submission another reviewer holds is
refused. Still open: pulling an accepted, unsampled submission into review
later as a spot check, and releasing or taking over a hold before it lapses.

### 5. Earnings page and rates frozen at submission

`submitAssignment` copies the project's `rateCents` and `payMode` onto the
assignment in the write that stores the answer, and `payoutReport`, its CSV
and the new `/earnings` page read the copy. `computePayouts` groups by
project, pay mode and rate. The day work became payable is stored in
`Assignment.payableAt` by the write that accepts it, and both reports go by
it. `/earnings` shows a person their own blocks for a range and, whatever the
range, what is waiting for review or was sent back. Revising time is added to
the active time. Different from the design: the payable day is a stored
column and not derived, and work accepted before the upgrade keeps its
submission day, so no past report changes; check constraints refuse a
submitted row without its rate and accepted work without its date; a revision
is credited at most the project's time limit and a task three limits in all,
because revising has no deadline, and a person's time is credited once
across all their work through the stretches of time already credited; and
hourly rounding moved into one integer function. The page says that nothing
is marked as paid, because the portal does not record payments. Still open: the rates of work from before the
migration are the project's rate of that day, which is an approximation, and
marking a period as paid, bonuses, reviewer pay and other currencies remain
out.

### 6. More import and export formats

One table, `EXPORT_FORMATS` in `domain/export.ts`, feeds the download route
and the export page. New in it: CoNLL BIO tags for entity projects (with a
tokenizer in `domain/tokenize.ts`) and YOLO and Pascal VOC for boxes, as a
zip from a writer in `domain/zip.ts`. Exports stream task by task and name
annotators by a pseudonym unless `annotators=email` is asked for. Import
reads JSON arrays, tab-separated and semicolon files, and `Batch.format`
grew `JSON` and `TSV`. Different from the design: a file is imported
completely or not at all, so "skip invalid rows" is gone; the JSON Lines and
CSV exports can be imported again, the consensus coming back as the gold
answer, and the CSV export got `submitted_at`, `answer` and `data` columns
for that; CSV cells that a spreadsheet would run as a formula are guarded;
the upload is cut off at 5 MB while it is read; a batch is refused when the
schema changed under it; and the count of spans that do not line up with
tokens is on the export page, on request, because a stream cannot report it.
The zip is read back in the tests by Python's `zipfile` and a small reader
instead of `fflate`. Still open: a zip holds at most 65,533 tasks (no zip64),
COCO keeps its box list in memory while it streams the images, and the
annotations of single annotators do not come back from a re-import.

### 7. Scheduled backups

A `backup` service in `docker-compose.yml`, behind the `backup` profile, runs
`docker/backup.sh` in the `postgres:17-alpine` image: a `pg_dump` into
`./backups` once a day, keeping the newest seven. It is a shell loop with
`sleep`, not cron. The age of a dump and the order of pruning come from the
time in the file name, never from modification times, and after every attempt
the loop pauses before the next. Different from the design: a dump right away
is `docker compose run --rm backup once`, because without an argument the
service is the daily loop, and that makes a dump at the start only when the
newest one is older than a day. A restore is part of the script
(`backup restore <file>`), loading the dump into a new database and swapping
it with the old one in one transaction, so that a database with the name
exists at every moment. Dumps dated in the future are never pruned and do not
count towards the seven. CI runs `docker/check-backup.sh` after
the tests, with the demo data in: the loop and the pruning against made-up
clocks, then a real dump, a restore into a scratch database and the row
counts. Still open: the dumps are not encrypted and stay on the same disk
unless `BACKUP_DIR` points elsewhere, and nothing warns when a dump fails
apart from the service's log.

### 8. Accessibility pass

Every labeling action now has a keyboard path: entity spans are marked with a
word cursor (arrows, Shift to extend, Enter), and the list under a box image
says each box's label and position and hands focus to it. Classification
labels, the pairwise preference and the review score are real radio groups.
Focus moves to `<main>` after a navigation and to the next task after "Submit
and next", which a live region announces; span and box changes, the time
left and a failed draft save are said too. The list of shortcuts is a modal
dialog that keeps and gives back focus. `text-slate-400` is gone, `aria-sort`
is on the `<th>` and each rationale has its own id. More time can be asked for
three times per claim, each in the last two minutes (a new `extensions`
column); a first submission is still credited at most two time limits. A `dom` test project runs
axe over the four interfaces and the main pages, with one shared helper and
only `color-contrast` switched off; contrast is worked out from the
stylesheet in a unit test instead. Different from the design: the contrast
check is automated rather than by hand, and the countdown speaks at 10, 5
and 1 minutes. Still open: target sizes, reflow and the colours a schema
picks for its entity types are still checked by hand, and there was no
session with a real screen reader.

### 9. Disputes on review decisions

An annotator can dispute a send-back or a correction from
`/my-work/:assignmentId`, once per decision and within
`Project.disputeWindowDays` (14 by default, 0 turns disputes off). Anyone who
can review, except the reviewer who decided and the annotator, settles it on
the new Disputes tab with a note. Overturning is one transaction: the review
keeps its row and gets `overturnedAt`, the submission becomes approved, the
task is refreshed, and every reader named in the design skips the overturned
review. An overturned send-back is dated at the overturn; an overturned fix
keeps its date. Sent-back work cannot be revised while its dispute is open.
Different from the design: the window is a project setting instead of a fixed
14 days, the dispute stores a copy of the answer it was about, the annotator
can withdraw an open dispute, and a dispute is not opened when nobody but the
deciding reviewer could settle it. Since item 5 the pay reports go by the day
work became payable, so an overturned send-back shows in the period of the
overturn and never in the one it was submitted in. Still open: gold scores
and low QA scores on approved work cannot be disputed, and nobody is told
about a new dispute or its outcome except by the tab count and the "My work"
page.

### 10. Gold tasks: add, fix and rescore

On the task page a manager can change a gold answer, rescore, retire a gold
task or bring it back, and copy a completed task into a gold task (also for
several tasks from the batch page). Every change is kept in `GoldRevision`
with who, when and why. Annotators see their score and the expected answer
after submitting unless the project turns gold feedback off, the quality page
lists the gold tasks with the lowest scores, and batch progress counts gold
apart. Different from the design: an edit does not rescore by itself. The
page first says how many scores change, whose accuracy moves and who crosses
the flag, and the manager applies exactly that plan. The copy does not go
into a batch named "Gold" but among the open tasks of a batch that is being
worked on, without the original's id, because annotators see the batch name;
a task and its copies are one item that nobody is handed twice; and the work
page gets no id of the task, only a reference cut from the claim's id. Gold
feedback is on for new projects and off for the ones that existed before. Pay
and past qualification attempts never follow a rescore. Still open: gold spacing is left to item 12 (a copy takes
the position of a random open task), a retired task that someone has claimed
can still be submitted, and the server does different work for a gold
submission than for a regular one, which a patient observer could measure.

### 11. Low-agreement tasks: extras and adjudication

Off by default. With `agreementThreshold` set on a project, a task that has
its accepted answers is compared once with the threshold (in whole
percentages, the agreement each kind already has); under it the task gets an
extra slot, up to `maxExtraAnnotators` (0 to 3, default 1), filled through the
normal queue, and after the last one it goes to `ADJUDICATION`, majority or
not. A reviewer or manager who did not label the task settles it from the task
page with one of the accepted answers, the consensus or an answer of their
own, with a reason; that answer is stored as the consensus with who, when and
why, and later reviews leave it alone. A manager can send a task that waits
for an extra annotator to adjudication at once. The JSONL export says
`majority` or `adjudicated`, the quality page counts both, and the batch
filter, batch list and progress know the new status. Different from the
design: the threshold is a whole percentage and the comparison rounds the
agreement the same way, so two against one meets 67%; the rule only runs on
open tasks, so changing the settings never reopens a completed one; an
adjudication tab is only shown while the threshold is on or tasks wait. Left
as the roadmap leaned: adjudicated answers do not feed back into annotators'
numbers. Still open: a task already waiting for an extra keeps that slot when
the number of extras is lowered.

### 12. Queue order, batch priority and gold spacing

Managers set a priority on a batch and pause or resume it from the batch page,
with activity entries; the batch list shows both. A project can hand out tasks
in import order or shuffled, and can space gold tasks out ("about one gold
task in every N"). The whole choice is one statement, `nextTaskSql`, that
picks and locks the task (`FOR UPDATE SKIP LOCKED`) and is the same for the
same inputs. Different from the design: every hash is an HMAC keyed with a
random secret per project that never leaves the server, so neither the
shuffled order nor gold timing can be worked out from ids; gold spacing is a
draw without memory (each claim is gold with a chance of 1 in N, with a cap
on streaks) instead of counting submissions, never makes the first task of a
session (30 minutes without a submission) gold, and falls back to the other
kind so the queue never runs dry. New indexes on
`Task(batchId, status, position)` and `Task(batchId, status, isGold,
position)` serve import order; shuffled order sorts the open tasks of one
batch at a time. Still open: the daily limit, a manager releasing a claim and manual
assignment, as planned, and the measurements of item 17.

### 13. Moving, resizing and zooming boxes

A selected box can be dragged, resized from eight handles, and moved and
resized with the arrow keys; `n` puts a new one in the middle of the view, so
the box interface works without a pointer. The view zooms (wheel, `+`, `-`,
`f`, buttons) and pans (Space with a drag, or a plain drag in a read-only
view). Zoom and position are kept per assignment for the session and never
reach the draft or the answer, which stay in image pixels. Undo and redo
(`Ctrl+Z`, `Ctrl+Shift+Z`, buttons) cover drawing, moving, resizing,
relabelling and removing. The maths is in `domain/geometry.ts` (hit testing,
`moveBox`, `resizeBox`, the view) and `domain/history.ts`, and the keys are
rows of the key map. Different from the design: resizing by keyboard is a
mode (`r` makes the arrows resize) and not a second modifier, because Alt and
Ctrl with the arrows belong to the browser, the system and screen readers, and
Shift is the ten pixel step; `r` is therefore no label letter any more. Boxes
got no ids: the selection travels with every history step instead. A move or
resize that is let go more than 24 pixels outside the picture is taken back,
like one cancelled with Escape or by a lost pointer; within that margin the
box stops at the edge. A read-only picture leaves the wheel and touch to the
page until it has been zoomed with a button or a key. Still open: no pinch
zoom on touch screens; entity spans keep their one-step undo and do not use
the history yet; on an AZERTY keyboard `-` is on the 6 key, where the label
wins, so zooming out there takes the number pad, the wheel or the button.

### 14. Image classification

A new kind, `image_classification` (`imageField`, `labels`, `multiple`), with
a `TaskKind` enum value and a migration. The answer is `ClassificationAnswer`
and goes through the same validation, consensus, gold scoring, agreement and
export as text classification; the label group was taken out of the text
interface (`label-choices.tsx`), keys included, and both kinds use it. The
places TypeScript does not point at were found by hand and are now listed
under "Adding a labeling kind": `categoricalValue` names every kind and has no
default, the quality page asks `isCategorical`, `mainField` and `isImageKind`
cover the preview, the batch search and the image check of the import,
`KIND_NAMES` and the test helper use the app's own maps. An image that does
not load shows its address and points to Skip, on box tasks as well, and
nothing can be labelled or handed in until it loads;
`TaskContext` now hides `width` and `height` only for boxes. Image addresses
follow the rule from item 6 and the server never fetches them. The demo has a
fifth project. Decided: a new kind rather than an `imageField` on text
classification. Still open: uploading images, which stays out because the app
stores no files.

### 15. Audit trail

`Activity` belongs to an organisation, may be about no project and keeps the
actor's name, so an entry outlives the account and the project. Every change
managers, reviewers and admins make is written in the same transaction as
the change: projects, settings (`detail.changes` maps a field to
`[before, after]`, the instructions as two lengths), batches, members,
qualification resets, gold tasks, review decisions, settled disputes, people,
roles and passwords, plus sign-ins, lockouts of known accounts and the three
downloads. `/audit` for admins has filters for person, action, project and
days, pages and a CSV download; the project tab has pages. Different from the
design: entries are append-only in the database too, through triggers that
refuse UPDATE, DELETE and TRUNCATE and let only a foreign key cascade clear a
link or remove an organisation's entries; review decisions
and settled disputes get a short entry (whose work, which task, the decision,
the QA score or the outcome) although their rows exist, because they change
pay and quality and the trail should show them in one place; a gold edit no
longer stores the old and new answer, and old entries lost that text in the
migration; only admins see `/audit`, project managers see their projects'
tabs. Tasks settled in adjudication and sent there by hand (item 11) are
recorded as well. Still open: entries are kept for ever, and someone with the
database owner's rights can still drop the trigger.

### 16. API tokens and a JSON API

Tokens are made, listed and revoked on the account page; a token is shown
once, stored as its SHA-256 and a prefix, has a name, an expiry, a last-used
time (written at most once a minute) and is read-only unless writing is asked
for. `requireApiUser` is the only code that reads one and returns the same
`CurrentUser` as the pages, with the role read on every request, and
`apiRoute` marks the routes that take a token, says whether each reads or
writes, refuses a read-only token on a write in one place and answers JSON
errors. The routes are the five of the design, plus a JSON 404 for anything
else under `/api`. Each token may make 120 requests a minute. Different from
the design: the import page and the API share `importFile`, the download and
the API share `labelExport`, and the task page and the lookup share
`requireTaskViewer`, so no check exists twice; the lookup lists every task
with the external id, as ids are unique only within a file; the key is kept
with the SHA-256 of the body, and a used key with another file answers 422;
an `/api/` path refuses the session even in a route that forgets `apiRoute`;
making
and revoking tokens is in the audit trail. Still open: webhooks and scopes
beyond read-only, and the limit is per process like the sign-in limit.

### 17. Faster on large projects

Measured on a fixture of 200,000 tasks (half complete, 40% full and waiting
for review, gold every 50th), old and new code side by side on the same data,
with identical results for the pick, the dashboard count, the schema check and
the quality page. Claiming: `Task.takenSlots` counts a task's active claims
and submissions, kept by a trigger on `Assignment` in the statement that
writes it, so no code path can miss it; `eligibleFor` compares it on the
task's row, and `claimNextTask` and `countAvailable` mark expired claims first
so the counter equals the old count. A claim past 80,000 full tasks went from
about 300 ms to 80 ms and the dashboard count about three times faster; a
shuffled claim hashes and sorts only tasks with a free slot, about 650 ms to
120 ms. Quality: two statements in place of nested relations, about 25 s to
4 s, with the per-annotator loop unchanged. Schema check: each different
answer is taken apart once and counted as many times as it occurs, 2 to 3 s
to under 1 s for classification (no gain for entities or
boxes, where answers are all different). The annotator page has pages. CI has
a 20,000 task fixture and asserts work done, not time: assignment rows read by
the claim, the number of times answers are unnested, the statements the
quality page runs, and a random series that compares every counter with a
fresh count. Different from the design: export paging and streaming had
already come with item 6, so this item adds nothing there; counts per
annotator stay in the JavaScript loop over rows read in SQL instead of a
`GROUP BY`, which keeps the results the same to the last digit. Left out: the
import cap stays at 5,000 rows and 5 MB, since nobody has asked for more, and
the schema check still runs on each load of the settings page. Still open: a
claim still visits each full task's row (an index cannot hold a comparison
with the project's overlap), and the trigger makes bulk inserts of
assignments slower, which only a fixture does.

### 18. Pre-labeling hook

Tasks can carry a suggested answer, from a `_prediction` column in the import
or from the project's rule, with `suggestion` and `suggestionSource` on
`Task`, `prelabel` on `Project`, and `fromSuggestion` and
`suggestionUnchanged` on `Assignment`. Rules are entries of a registry in
`domain/prelabel.ts` with one function type; the two that ship are keyword
lists for classification and phrase lists for spans (longest first, no
overlaps), capped in number and length, with no regular expressions and no
service. Everything suggested is checked like an answer. The rule runs after
the import, off the request, with a 15 second limit, and the batch page shows
its state and runs it again. The work page shows the suggestion in a dashed,
labelled box and fills nothing in until "Start from the suggestion", so a
suggestion is never handed in without an action; a draft wins. Suggestions
count nowhere: not in consensus, agreement, gold scores or pay. The quality
page shows each annotator's unchanged share and time and scores the
suggestions against gold, with a note that agreement leans towards the
suggestion; the export carries the suggestion and how each annotation used
it. Different from the design: gold tasks get the rule's suggestions like any
other task, because a task without one would stand out as gold, but never a
file's: a `_prediction` on a `_gold` row is refused and a gold copy keeps only
a rule's suggestion; a project with file predictions and no rule gets a note
on the quality page that its gold tasks can be told apart. Everyone sees the
suggestion, as the item leaned. Matching is one left-to-right pass with a
fixed cost per task, "Continue" goes on after a timeout and "Run again from
scratch" follows a rule change, tasks someone has been handed are never
touched, and taking a suggestion is recorded on the server when it happens.
Still open: the rule runs in the web process, so a run cut short by a restart
only goes on when its batch page is opened; the CSV export does not carry
suggestions; image classification and boxes have no rule.

### 19. Releasing a claim and a daily task limit

Admins and project managers release a claim from "Claims" on the task page
(`intent=release-claim`, `releaseClaim` in `models/queue.server.ts`), under the
lock order of a submission: the annotator's work clock, the task row, then
the claim, with an `assignment.released` audit entry in the same
transaction. The confirmation says how long the claim has run, whether a
draft is lost and whether its time is paid. As the item leaned, the release
credits the time the draft saves recorded through `lockWorkClock` and
`creditTime`, but only on hourly projects, where time is what is paid; a
per-task project pays per accepted task, so nothing is credited there. The
released row carries the credited seconds, the rate and a payable date, and
payouts and earnings count it as time without a task, which needed the
payable-date check constraint widened for released rows with an hourly rate.
`Project.dailyTaskLimit` (empty is no limit) is in the settings form and the
settings audit diff. A claim counts the person's submissions in the project
since midnight UTC plus the claims they hold, under a lock on their work
clock as the item leaned, so two tabs cannot both pass; a tab that finds the
other tab's new claim under the lock resumes it. Skips do not count.
`countAvailable` answers 0 at the limit, and the project page says when the
next day starts. Different from the design: `releaseClaim` also takes the
project, so a claim can only be released from its own project's page. Left
out, as the item suggested: raising the limit for one person. Still open: a
resubmission moves `submittedAt`, so revising sent-back work counts towards
the day it is handed in again.

### 20. Signing out everywhere

`User.sessionVersion` and a `v` in the cookie, compared in the query
`getCurrentUser` already makes. The number goes up when an admin sets a
password, when a person changes their own (that tab gets a new cookie in the
same response), with "Sign out everywhere" on the account page and with "End
sessions" on People; the last two are `person.sessions_ended`, told apart by
`detail.own`. A cookie without `v` reads as 0, so the upgrade signed nobody
out. API tokens are left alone: the account page names the ones that still
work next to the button and after a password change, and People shows the
person's working tokens after "End sessions" or a new password, each with a
Revoke button. Different from the design: that admin revoke is new
(`revokeApiTokenOf`, recorded with whose token it was), since a link to the
person's own account page would not have helped the admin. "Sign out
everywhere" signs out this browser too, and admins end their own sessions from
the account page, not People. An open work page still reaches "Draft not
saved" through the redirect. Also beyond the design: removing a person bumps
the version and revokes their tokens in that organisation, so a re-add brings
neither back. The version is per account, so ending sessions signs the person
out of their other organisations too, and People says so. Still open: a list of sessions with device and
time, which needs a table of sessions.

### 21. Spot checks and letting go of a review hold

Reviewers and managers get "Spot check" on the annotator page and the task
page next to accepted work that no reviewer has seen (`NOT_REQUIRED`, not
gold or qualification, no review yet, not their own). The review page opens
it in spot-check mode: a QA score, a verdict (fine, or would have sent it
back, which needs feedback) and feedback the annotator sees on "My work".
`recordSpotCheck` stores a `Review` with `spotCheck` set and an audit entry,
under a lock on the submission's row only, and changes no status, pay, task
or consensus. Every reader of reviews says what it does with them: the
quality page and its CSV count spot checks in a column of their own and
keep them out of the approval rate, the reviewed share and the QA score;
the reviewer's dashboard numbers and the label export's QA score leave them
out; disputes and the revise page look only at real decisions, so a spot
check cannot be disputed; "My work" shows its feedback. The review page has
"Let go of it" for the reviewer who holds a submission, and the review
queue "Release" for managers, a conditional write on the holder the page
showed, with an audit entry. Decided on the open point: a spot check takes
no fix, so it never touches a consensus, adjudicated or not; a reviewer who
finds a wrong answer says so in the verdict and feedback. Still open: a spot
check is not offered from the review queue itself, and there is no way to
pull a batch of someone's work in for spot checks at once.

### 23. Backup status the app can see

`BackupRun` rows (start, end, ok, file, bytes, message, interval) written by
`docker/backup.sh` with `psql` after every attempt, with psql variables so a
message cannot break the statement; a missing table is a line in the log and
`BACKUP_STATUS=off` writes nothing. Admins get "The last dump failed" and "No
dump for N hours" on the dashboard's needs-attention list once a row exists,
with the last good dump and a note that after a restore the list ends at the
dump before the restored one. Decided: late means the newest good dump is 1.5
intervals old, using the interval the newest row carries, so the app needs no
setting of its own; `/healthz` carries nothing; only admins see it, since a
dump holds every organisation; encryption is left to the disk and documented.
The restore check leaves `BackupRun` out of its comparison and checks the
rows on their own (one fewer in the copy). After review: rows are read in
the order they were written (by id), not by the container's clock; a failed
row keeps pg_dump's error line in ASCII; the script keeps the newest 500 rows.
Still open: nothing reaches anyone who does not open the dashboard.

### 26. Background jobs that survive a restart

`Job` rows (kind, payload, run at, attempts out of a maximum, lease, last
error, done or failed) and a loop in `lib/jobs.server.ts` that takes due jobs
with `FOR UPDATE SKIP LOCKED` in one statement, runs the handler that
`JOB_HANDLERS` names outside any transaction of its own, and marks the job
done or puts it back after 30 seconds, doubling up to an hour, until its
attempts run out. The web process runs the loop from `entry.server.tsx`
unless `JOBS_IN_WEB=false`; a `worker` compose service (profile `worker`)
runs the same build through `docker/worker.mjs`. The suggestion rule moved
onto it: `startPrelabel` adds a keyed job in the transaction that marks the
batch `PENDING`, `isPrelabelRunning` reads the job, and "Continue" and "Run
again from scratch" add one with their change. Decided: polling every five
seconds, plus a wake-up in the process that added the job; one open job per
key under an advisory lock instead of a partial unique index, which Prisma's
schema cannot hold. Beyond the design: finishing and putting back name the
attempt, so a run whose lease ran out cannot undo a newer one; the migration
turns batches left `PENDING` into jobs; the batch page no longer starts a run
when it is opened. Still open: finished jobs are never removed and nothing
lists them.

### 28. Two-step sign-in

TOTP in `domain/totp.ts` (tested against the RFC 4226 and 6238 vectors),
set up on the account page with the secret as text and as a QR code drawn
on the server by `qrcode`, turned on by one right code, with ten recovery
codes kept as SHA-256. After the password the cookie holds only a pending
sign-in until `/login/two-step` gets a right code. Decided: the secret is
encrypted with AES-256-GCM under a separate `TOTP_KEY`, asked for in
production only once someone uses the feature; a code works once through
the stored time step, moved forward in one conditional update, with one
step of drift either way. Wrong codes are limited per account and client
address so a guesser elsewhere does not lock the owner out; the address
comes from `X-Forwarded-For` only with `TRUST_PROXY=true`, since the app
never sees the socket, and without it the limit is per account. The
organisation rule on People asks it of admins and project managers, who are
kept on their account page until they set it up; an admin can only turn the
rule on with their own on. Turning it on and an admin's reset end the
person's sessions. Still open: passkeys, and new recovery codes without a
reset.

### 31. Rate limits shared between processes

`RateLimiter` counts in the UNLOGGED table `RateLimitHit` with one `INSERT
... ON CONFLICT DO UPDATE ... RETURNING count` per attempt, for the sign-in,
the second step (item 28) and the API. `hit` and `reset` are async; a
limiter has a name that prefixes its keys. Different from the design: one
row per key rather than per key and window, rolled over in place when its
window is past, so a window still starts with the first attempt as before
and a burst is never split by a clock boundary. `justLocked` is true for
exactly one attempt, since the row puts concurrent ones in line. Decided:
always the table, no memory limiter left, so there is one code path. Old
rows go every thousandth attempt in a process, not on a row count. Still
open: nothing.
