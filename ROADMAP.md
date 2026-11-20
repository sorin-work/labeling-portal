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

"Depends on" lists real prerequisites only. Items that merely touch the same
file are not listed there; the bigger overlaps are mentioned in the items.

## Overview

| #   | Item                                         | Group | Area          | Size | Depends on |
| --- | -------------------------------------------- | ----- | ------------- | ---- | ---------- |
| 1   | Drafts that survive a reload                 | Next  | labeling      | S    | -          |
| 2   | Safe schema edits once work exists           | Next  | projects      | S    | -          |
| 3   | Hotkeys for every action                     | Next  | labeling      | M    | -          |
| 4   | Review sampling and reviewer reservations    | Next  | review        | M    | -          |
| 5   | Earnings page and rates frozen at submission | Next  | payouts       | M    | -          |
| 6   | More import and export formats               | Next  | import/export | M    | -          |
| 7   | Scheduled backups                            | Next  | ops           | S    | -          |
| 8   | Accessibility pass                           | Next  | ui            | M    | -          |
| 9   | Disputes on review decisions                 | Later | review        | M    | -          |
| 10  | Gold tasks: add, fix and rescore             | Later | quality       | M    | -          |
| 11  | Low-agreement tasks: extras and adjudication | Later | quality       | M    | -          |
| 12  | Queue order and assignment rules             | Later | queue         | M    | -          |
| 13  | Moving, resizing and zooming boxes           | Later | labeling      | M    | -          |
| 14  | Image classification                         | Later | labeling      | M    | -          |
| 15  | Audit trail                                  | Later | ops           | M    | -          |
| 16  | API tokens and a JSON API                    | Later | api           | L    | -          |
| 17  | Faster on large projects                     | Maybe | performance   | L    | 12         |
| 18  | Pre-labeling hook                            | Maybe | labeling      | L    | -          |

## Next

### 1. Drafts that survive a reload

On the work page the answer lives only in React state (the `answer` state in
`routes/work.tsx` starts as `null`). A reload, a closed tab or a browser crash
throws away twenty drawn boxes or a half-written rationale. The working time
goes with it: `useActiveTime` starts again from zero, which on an hourly
project is lost pay.

The same state is also kept when it should go. `Work` is not remounted when
"Submit and next" moves from one `/work/:assignmentId` to the next (only
`LabelingInterface` has a `key`), so the next task opens with the previous
task's answer still in `answer` and the submit button enabled, and the seconds
counter runs on across tasks.

- First, reset per assignment: render the body of the page under
  `key={assignment.id}`, so `answer`, the skip form and `useActiveTime` start
  fresh for every task. This fixes the carry-over that exists today, and the
  rest of the item depends on it: without it the first autosave on a new task
  would store the previous task's answer and seconds as the new draft.
- Data: `draft Json?` and `draftSeconds Int @default(0)` on `Assignment`.
- A new `intent=draft` branch in the `work.tsx` action, next to `extend`,
  `release` and `skip`. It calls a new `saveDraft` in `models/queue.server.ts`
  that uses the same `ownActive` check as the others and stores the seconds
  through `clampActiveSeconds`. It answers with JSON and does not redirect.
- The loader returns the draft. With the key in place the component starts
  `answer` from it, and `useActiveTime` takes `draftSeconds` as a starting
  value, so after a reload the counter continues instead of restarting.
- The page saves through `useFetcher` a few seconds after the last change and
  when the tab is hidden, and shows "Draft saved" next to the working time.
- Tricky: a draft is not a valid answer. A pairwise draft starts with
  `preference: null` (the `EMPTY` constant in
  `components/labeling/pairwise.tsx`), so drafts are stored without
  `validateAnswer` and only checked for size (say 200 KB). Submitting still
  validates.
- Tricky: `submitAssignment`, `skipAssignment` and `releaseAssignment` should
  clear the draft, so finished rows do not carry it around.
- Tricky: the same task open in two tabs. The last save wins, which is fine,
  because only the submit counts.
- Related: revising sent-back work (`routes/my-work-revise.tsx`) and the
  qualification test (`routes/project-qualification.tsx`, several questions in
  one form) lose their state the same way. The revise page can use the same
  column, with its own guard because that assignment is `SUBMITTED`, not
  `ACTIVE`. The test has no row to hang a draft on; `sessionStorage`, as in
  `useRemembered`, is enough there.
- Undecided: a draft on the server or only in `localStorage`. I lean towards
  the server: it follows the annotator to another device, it keeps the working
  time honest, and nothing is left behind on a shared computer.
- Tests: next to the work route tests in `tests/integration/queue.test.ts`:
  save and load again, seconds are clamped, cleared on submit, the next
  assignment's loader returns no draft, not found for someone else's
  assignment, refused once the claim is no longer active. The reset between
  tasks is component behaviour; a test for it has to wait for the DOM test
  setup of item 8.

### 2. Safe schema edits once work exists

The settings form lets a manager change anything in the task schema at any
time. `parseProjectForm` only checks that the JSON is a valid schema, and
`updateProject` writes `kind` and `schema` straight to the row. Removing a
label that 500 answers use, renaming `textField` after the import, or turning
a classification project into a box project all save without a word.
Afterwards review, consensus and export read the old answers with the new
schema.

- A pure `diffSchema(before, after)` in a new `domain/schema-diff.ts` that
  returns a list of changes, each marked safe or breaking:
  - the kind: breaking as soon as the project has a task;
  - field names (`textField`, `promptField`, `responseAField`,
    `responseBField`, `imageField`): breaking once tasks exist, because the
    imported rows only have the old field;
  - labels, entity types, box labels: adding is safe, removing or renaming is
    breaking when a stored answer uses the name;
  - `multiple` from true to false: breaking when an answer has two labels;
  - `allowTie` from true to false: breaking when an answer is a tie;
  - rubric dimensions: adding one is breaking once answers exist. Old answers
    have no score for it, `pairwiseConsensus` can average a missing score as
    0, and `validatePairwise` refuses a reviewer's fix of an old answer until
    the new dimension is scored too. Removing one only orphans numbers and
    can be allowed with a warning;
  - `minRationaleLength`, `minBoxSize`, colours, descriptions: safe.
- Whether a name is in use needs the stored answers: `Assignment.answer`,
  `Review.correctedAnswer`, `Task.goldAnswer`, `Task.consensus` and
  `QualificationAttempt.answers`. A `schemaUsage(projectId)` in
  `models/projects.server.ts` can count them with one `$queryRaw` over the
  JSON columns.
- The `routes/project-settings.tsx` action answers 400 with `errors.schema`
  listing what breaks and how many answers are affected. Safe changes save as
  today. `ProjectForm` already runs `parseTaskSchema` while typing; it can run
  the diff against the saved schema as well and show it before the save.
- The way out for a real redesign exists: "Duplicate" (`duplicateProject`)
  copies the setup into a new draft without tasks. The error should say so.
- Record the change in the `project.settings` activity entry, whose `detail`
  is empty today, as `detail.changes.schema = [before, after]` with the two
  schemas as JSON. This is the one shape for settings changes, a map from
  field name to `[before, after]`, and item 15 uses it for every other field.
  The list from `diffSchema` is not stored: the activity page runs the diff on
  the pair when it describes the entry.
- Tricky: tasks and answers are separate checks. A draft project with imported
  tasks and no answers can still be broken by a field rename.
- Undecided: a "rename this label everywhere" action that rewrites the stored
  answers in one transaction. Useful, but it touches five JSON columns; I
  would leave it out of the first version. Also whether an admin may force a
  breaking change. I lean towards no.
- Tests: unit tests for `diffSchema` for every kind; integration tests in
  `tests/integration/projects.test.ts` for a blocked and an allowed save.

### 3. Hotkeys for every action

Shortcuts exist but stop early. The number keys reach the first nine labels
only (`Math.min(9, ...)` in `text-classification.tsx`, `ner.tsx` and
`bounding-boxes.tsx` under `components/labeling/`, while a schema may have 30
labels). The pairwise rubric can only be clicked, two clicks per dimension on
every task. Skip has no key. The review page knows `1` to `5` and `a`. The
list behind `?` (`KeyboardHelp`) is a hard-coded table that only the work page
shows.

- One key map as data, in a new `domain/hotkeys.ts`: for each page (work,
  review) and labeling kind, which key does what, plus a function that hands
  out the label keys. The handlers and `KeyboardHelp` both read it, so the
  help cannot drift from the behaviour, and the review page can show its own
  list. This item owns the module. Items 8 and 13 add their keys to it, and if
  one of them is built first it creates the module in this shape with its own
  keys.
- Label keys: `1` to `9`, `0` for the tenth, then letters, shown on the
  buttons the way the digits are today. Letters that the page or the interface
  uses for something else are skipped: `s` on the work page, `a`, `s` and `e`
  on the review page, `n` and `f` in the box interface (item 13).
- Pairwise scores: every score row (one dimension, one side) is a radio group.
  Inside a group the arrow keys choose, the same as in a native radio group,
  and Tab moves to the next group. `1` to `5` set the score of the group that
  has focus and move focus to the next one (A then B for each dimension), so a
  rubric can be filled in by typing digits. The digits are free in this
  interface. `a`, `b` and `t` stay. Item 8 asks for the same radio behaviour,
  so the two items agree and can land in either order.
- Entities: clicking a span removes it today (`onClick` on the `<mark>` calls
  `removeSpan`), so a span with the wrong type has to be deleted and selected
  again. Make a click select the span; a number then changes its type and
  Delete removes it, as for boxes.
- Work page: `s` opens the skip form (Escape already closes it). Review page:
  `s` moves to the feedback box for sending back, `e` starts "Fix it myself",
  Escape cancels the fix. Not `f`: that is zoom to fit in the box interface
  (item 13), which the read-only view on the review page has too.
- `isTyping` in `components/labeling/use-hotkeys.ts` stops the handler for
  every `INPUT` element, radio buttons and checkboxes included. So shortcuts
  go dead while a radio has focus (the skip form focuses one today), and they
  would go dead inside any score group made of real radio inputs. The hook
  must stop only for text entry: text inputs, textareas, selects and editable
  content. The arrow keys and Space still belong to a focused radio or
  checkbox. While the skip form is open the interface keys should stay off,
  which the focused radio did by accident until now. Items 8 and 13 need this
  change as well; whichever of the three lands first makes it.
- Tricky: `useHotkeys` listens on `window` for every mounted interface. The
  qualification test renders one interface per question
  (`routes/project-qualification.tsx`), so pressing `1` there picks the first
  label in every question at once. Keys should go to one interface: the one
  that has focus or was used last.
- Tricky: the handlers compare `event.key`, which depends on the keyboard
  layout (on AZERTY the digit row needs Shift). `event.code` for the digits
  fixes that and makes the number pad work.
- Tricky: on the review page `a` approves, and in a pairwise fix `a` picks
  response A. The page turns its own keys off while fixing; the shared table
  should make that rule explicit instead of leaving it to two hooks.
- Undecided: "submit on pick" for single-label projects (press `2` and the
  next task loads). It is the fastest way to work and the easiest way to
  submit a slip, and there is no way back to a submitted task. I lean towards
  an option per annotator, off by default.
- Tests: unit tests for the map (no key used twice on one page and kind, the
  read-only interface keys counted on the review page, label keys for 30
  labels skipping the reserved letters), for the order in which the digits
  walk through the pairwise groups, and for the "is this text entry" rule as a
  pure function. Key handling inside components cannot be tested until item 8
  adds a DOM test setup, so keep the logic outside the components.

### 4. Review sampling and reviewer reservations

Two gaps in the review queue. First, `reviewRequired` is all or nothing: every
submission waits for a reviewer, or none does. With annotators I trust I want
to review a share. Second, the queue hands the same submission to everyone:
`nextPendingReview` returns the oldest pending row to each reviewer who
presses "Start reviewing", and the slower one gets "Someone already reviewed
this submission" (the 409 in `routes/review.tsx`) after doing the work.

Sampling:

- Data: `reviewSamplePercent Int @default(100)` on `Project`, used when
  `reviewRequired` is on. It needs a field in `ProjectForm` and
  `projectFormSchema`, and a line in `createProject`, `updateProject` and
  `duplicateProject`.
- `submitAssignment` in `models/queue.server.ts` chooses between `PENDING` and
  `NOT_REQUIRED` from `input.reviewRequired && !task.isGold`. The draw goes
  there. Pass the random function in, the way `now` is passed in, so tests can
  fix it.
- Work that is not sampled is accepted at once, so `refreshTaskStatus` has to
  run for it. Today it only runs when the project has review switched off.
  Items 1 and 5 add their own lines to `submitAssignment`; the three changes
  do not depend on each other.
- Tricky: new annotators. With a flat 10% somebody's first thirty submissions
  may never be seen. Always review an annotator's first ten submissions in a
  project, and everything from annotators the quality page flags (`flagged` in
  `models/quality.server.ts`: gold accuracy under `GOLD_PASS_SCORE`).
- Tricky: decide once. Work that was sent back and resubmitted always returns
  to `PENDING` (`resubmitAssignment` does that already).
- The quality page should show what share of each annotator's work was
  reviewed, or the approval rate reads as if it covered everything.

Reservations:

- Data: `reviewHeldById` and `reviewHeldAt` on `Assignment`.
  `nextPendingReview` takes the oldest pending submission that nobody else
  holds (holds older than 15 minutes do not count) and marks it in the same
  statement, with `FOR UPDATE SKIP LOCKED` in a `$queryRaw`. `claimNextTask`
  locks task rows for the same reason.
- "Start reviewing" is a link to `?next=1` handled in the loader of
  `routes/project-review.tsx`. Reserving is a write, so it becomes a POST, like
  the claim in `routes/project-work.tsx`.
- The list (`listPendingReviews`) shows who holds a row. Opening a held
  submission directly still works and says who is on it. The action keeps its
  `reviewStatus !== 'PENDING'` check as the last line of defence.
- `recordReview` clears the hold. Abandoned holds just age out; there is no
  background job in this app.
- Undecided: letting a manager pull an accepted, unsampled submission into
  review later as a spot check. I lean towards leaving it for a follow-up.
- Tests: `tests/integration/review.test.ts`: sampled and unsampled with a
  fixed random function, the first-ten rule, the task completes when unsampled
  work fills it, and two reviewers asking at the same moment get different
  submissions (the queue tests do the same with `Promise.all`).

### 5. Earnings page and rates frozen at submission

Annotators see hours and counts on the dashboard (`myStats`) but never money:
`/payouts` is for admins and project managers. And the report prices all past
work with each project's current `rateCents` and `payMode` at the moment
someone opens it (`payoutReport` in `models/payouts.server.ts`), so changing a
rate in the settings silently reprices every earlier month.

- Data: `rateCents Int?` and `payMode PayMode?` on `Assignment`, written by
  `submitAssignment` from the project. The migration fills existing submitted
  rows from their project's current values. `payoutReport` reads the copy.
- `computePayouts` in `domain/payouts.ts` keeps one `rateCents` per project.
  With a rate change inside the range that is wrong, so group by project, pay
  mode and rate: such a project shows as two lines, also in the CSV
  (`routes/payouts-export.ts`).
- New page `/earnings` (`routes/earnings.tsx`, a link in
  `routes/app-layout.tsx` for roles that can annotate): a date range read with
  `readRange` as on the payouts page, then for each project the accepted
  tasks, active time, rate and amount, and separately what is still waiting
  for review or was sent back and is not payable yet. `payoutReport` counts
  that as `pending` for the whole organisation already. The loader uses
  `requireUser` and filters on the user's own id; no new capability.
- Tricky: hourly amounts are rounded once per block (`amountCents`). More
  blocks means the total can differ by a cent from before. State the rule on
  the page and test it.
- The date that puts work into a period changes. Today the report goes by
  `submittedAt`, so work approved in November still lands in October's total
  after October was paid. From now on work counts on the day it became
  payable: `reviewedAt` for work a reviewer approved or fixed, and
  `submittedAt` for work accepted without a review (`NOT_REQUIRED`: projects
  with review off, gold tasks, and work that the sampling of item 4 lets
  through). Both reports use this date, `payoutReport` with its CSV and the
  new page, and both say so on the page. A period that was paid then never
  changes afterwards. When item 9 overturns a send-back, that work becomes
  payable at the time of the overturn, for the same reason.
- Work that is waiting for review or was sent back has no such date yet.
  `payoutReport` keeps counting it as `pending` by `submittedAt` in the range;
  the earnings page lists all of it, whatever the range.
- Tricky: time spent revising sent-back work is not counted at all.
  `routes/my-work-revise.tsx` posts no `activeSeconds` and
  `resubmitAssignment` does not touch them. On an hourly project that is
  unpaid time. Count it with `useActiveTime` and add it to the assignment,
  capped at the time since the review.
- Tricky: gold tasks are paid like other work (`NOT_REQUIRED` is one of the
  `ACCEPTED_STATUSES`) and the qualification test is not. The page should say
  so, or people will count differently.
- Not in this item: marking a period as paid, bonuses and deductions, pay for
  reviewers (a `Review` records no time), currencies other than USD
  (`formatCents`, the `rate_usd` and `amount_usd` columns).
- Tests: `tests/unit/payouts.test.ts` for the grouping by rate;
  `tests/integration/payouts.test.ts`: a rate change leaves earlier work
  alone, an annotator sees only their own lines, revise time is counted, and
  work submitted in one month and approved in the next counts in the second.
  The existing cases use a project without review, so they go by `submittedAt`
  as before.

### 6. More import and export formats

Export writes JSONL, CSV and, for box projects, COCO. Whoever trains a model
on the labels then writes the same converters again: token tags for entity
projects, YOLO files for boxes. Import reads CSV and JSON Lines, and a `.json`
file is taken for JSON Lines (`detectFormat` in `domain/import.ts`), so an
ordinary JSON array is rejected line by line ("Not valid JSON").

- Formats are spread over three places: the `FORMATS` map and the conditional
  in `routes/project-download.ts`, the radio list in
  `routes/project-export.tsx` (with its own `kind === 'BBOX'` check) and the
  writers in `domain/export.ts` (`toJsonl`, `toCsvExport`, `toCoco`). First
  make one table (name, label, hint, kinds, content type, extension, writer)
  that both routes read.
- CoNLL-style BIO tags for entity projects: one token and its tag per line, an
  empty line between tasks. This needs a small tokenizer with offsets in
  `domain/`. Like COCO it uses the consensus, or the single accepted answer
  when there is no consensus.
- YOLO for box projects: one text file per image with `class cx cy w h`
  divided by `imageWidth` and `imageHeight` (both are in `BboxAnswer`), and a
  `classes.txt` in schema order. Pascal VOC (one XML file per image) is the
  same data in another wrapper.
- Both are many files, so the download is a zip, and the repo has no zip code.
  A writer for stored or deflated entries is under a hundred lines with Node's
  `zlib` (`deflateRawSync`, `crc32`).
- Annotator identity: every exported row carries the annotator's email
  (`a.user.email` in `models/export.server.ts`). Exports get passed around.
  Add an option for stable pseudonyms, for example `ann_` plus eight hex
  characters of a SHA-256 over project id and user id.
- Import: JSON arrays in `readRecords`, with "item 3" where the other formats
  say "line 3". `parseCsvRecords` in `domain/csv.ts` hard-codes the comma; a
  delimiter parameter gives TSV, and sniffing the header line gives the
  semicolon files that spreadsheet programs write in many locales.
- Tricky: spans are character offsets and need not line up with tokens
  (`trimSelection` trims whitespace only, so a span can cover half a word).
  Tag every token the span overlaps and count the spans that did not line up.
- Tricky: file names inside the zip come from `externalId` or the image URL.
  They need cleaning (no slashes, no `..`) and a suffix when two tasks share a
  name.
- Tricky: `Batch.format` is a Prisma enum with `CSV` and `JSONL`. A JSON array
  or a TSV file either records the nearest of those or the enum grows with a
  migration.
- Undecided: `fflate` instead of a hand-written zip writer. I lean towards
  writing it and using `fflate` as a dev dependency to read the result back in
  tests. And which identity is the default: I lean towards pseudonyms, with
  `annotators=email` in the URL for the old output.
- Tests: `tests/unit/export.test.ts` and `tests/unit/import.test.ts` for the
  writers and readers, `tests/integration/export.test.ts` for the downloads.
  `docs/import-export.md` gets the new formats.

### 7. Scheduled backups

Everything lives in the `db-data` volume of `docker-compose.yml` and there is
no backup. The label export is no substitute: it leaves out reviews, gold
answers, pay data, accounts and project settings.

- A `backup` service behind a compose profile, using the same
  `postgres:17-alpine` image as `db`, that runs `pg_dump --format=custom` once
  a day into a mounted folder and keeps the last N dumps. The script goes in
  `docker/backup.sh` next to `entrypoint.sh`. `docker compose run --rm backup`
  should take one dump right away.
- A "Backup and restore" section in the README with the restore command. An
  older dump restored under a newer app is fine: `docker/entrypoint.sh` runs
  `prisma migrate deploy` on start.
- A restore that is never tested is not a backup. Add a step to
  `.github/workflows/ci.yml` after the tests: put the demo data into the
  database (`npm run db:seed`; the tests truncate every table as they go, so
  little is left in it), dump it with the script, restore the dump into a
  scratch database and compare the row count of every table.
- Tricky: the runner's own `pg_dump` can be older than the server and then
  refuses to dump it. Run the tools from the same image, either with
  `docker exec` in the service container (`job.services.postgres.id`) or with
  `docker run --network host postgres:17-alpine`.
- Tricky: a dump holds password hashes and personal data. Create the files
  readable by their owner only, say so in the README, and add the folder to
  `.gitignore` and `.dockerignore`.
- Undecided: cron inside a container is clumsy. A shell loop with `sleep` is
  probably enough for one dump a day.

### 8. Accessibility pass

The basics are there: a skip link, visible focus, labelled navigation and form
fields, `role="alert"` on the time warning. I have never gone through the
labeling pages with only a keyboard or with a screen reader, and nothing in CI
checks any of it. Gaps I already know about:

- Entity spans can only be made with a mouse. `NerSpans` reads
  `window.getSelection()` on `mouseup`, and a span is removed by clicking it.
  It needs a keyboard path: while the text has focus, a cursor that the arrow
  keys move word by word, Shift with an arrow to extend, Enter to apply the
  active type.
- Boxes can only be drawn with a pointer. Item 13 adds moving and resizing by
  keyboard and a key (`n`) that drops a new box in the middle of the view.
  That part lives there, and this item does not wait for it.
- New keys go into the one key map in `domain/hotkeys.ts` that item 3
  describes (pages and kinds, key to action, read by the handlers and by
  `KeyboardHelp`). If that module does not exist yet, create it in that shape
  with the keys of this item.
- After "Submit and next" the next task loads without any announcement, and
  focus stays wherever it was. Move focus to the task, or announce it in a
  live region, in `routes/work.tsx`, and move focus to `<main id="main">` on
  navigation in `routes/app-layout.tsx`.
- `aria-sort` sits on the sort button in the quality table
  (`routes/project-quality.tsx`). It belongs on the `<th>`.
- The score buttons (`ScoreButtons` in `pairwise.tsx`) and the label buttons
  in `text-classification.tsx` have `role="radio"`, but each one is a tab stop
  and the arrow keys do nothing. Make every group behave like a native radio
  group: one tab stop, and the arrow keys choose. Real radio inputs give that
  for free. Item 3 describes the same behaviour for the pairwise scores and
  puts the digits on top of it, so the two items agree whichever lands first.
- `isTyping` in `components/labeling/use-hotkeys.ts` returns true for every
  `INPUT` element, so a focused radio or checkbox silences all shortcuts. With
  real radio inputs in the interfaces the number keys would go dead as soon as
  a score has focus. The hook must stop only for text inputs, textareas,
  selects and editable content. Items 3 and 13 need the same change; whichever
  of the three lands first makes it.
- `id="rationale"` is fixed in `PairwiseRubric`, so a page with two interfaces
  (the comparison in `routes/my-work-revise.tsx`, the qualification test) has
  the id twice. `useId` fixes it.
- `KeyboardHelp` opens a `role="dialog"` without moving focus into it or
  putting it back.
- `text-slate-400` on white is about 2.6:1 and is used for hints, key caps and
  meta text in some 25 places. Body text needs 4.5:1; `text-slate-500` passes.
- `Countdown` says nothing until the two-minute `TimeWarning`, and the limit
  can be extended once only (`extendAssignment`). People who need longer
  should be able to ask more than once.
- An automated check. Both projects in `vitest.config.ts` run in `node`, so
  there are no component tests at all. Add a third project with `jsdom`,
  `@testing-library/react` and `vitest-axe`, render the four interfaces and
  the main pages (through `createRoutesStub` from `react-router`) and fail on
  violations. Later items can test key handling there too.
- Tricky: jsdom has no layout and no colours. Contrast and anything that
  depends on element sizes stay a check by hand; write down the result in the
  pull request.
- Undecided: how many extensions. Unlimited extensions let one person sit on a
  task for ever. I lean towards three, each still asked for by the annotator.

## Later

### 9. Disputes on review decisions

A reviewer's decision is final. An annotator whose answer was fixed can look
at the correction, and one whose work was sent back can revise it, but nobody
can say "I think my answer was right". The decision still counts in their
approval rate, and a send-back they disagree with stays unpaid until they give
in. Being marked down with no way to contest it is the complaint I read most
often from people who do this work on the big platforms.

- Data: a `Dispute` model: `assignmentId`, `reviewId` (the decision, unique,
  so one dispute per decision), `openedById`, `reason`, `status` (`OPEN`,
  `UPHELD`, `OVERTURNED`), `resolvedById`, `resolution`, `createdAt`,
  `resolvedAt`. And `overturnedAt DateTime?` on `Review`.
- Annotator side: a "Dispute" button with a required reason on
  `/my-work/:assignmentId` (`routes/my-work-revise.tsx`, a new `intent`) for
  `SENT_BACK` and `FIXED` work, and the state as a badge in the list in
  `routes/my-work.tsx`.
- Resolver side: a "Disputes" tab in `routes/project-layout.tsx` with the open
  count, the way the Review tab shows `pendingReviews`, and a new
  `routes/project-disputes.tsx`. The decision page shows the task, the
  annotator's answer, the reviewer's correction and feedback side by side (the
  comparison in `my-work-revise.tsx` already renders two read-only
  interfaces), with "Uphold" and "Overturn" and a required note.
- Overturning has to undo the decision everywhere:
  - `finalAnswer` in `domain/outcome.ts` picks the latest `FIX` and must skip
    overturned reviews. It is called from `models/tasks.server.ts`,
    `models/quality.server.ts`, `models/export.server.ts` and
    `routes/task-detail.tsx`;
  - `Assignment.reviewStatus` becomes `APPROVED`, and `refreshTaskStatus`
    runs, because the consensus can change and the task may complete;
  - pay goes by the day work became payable (item 5), which for reviewed work
    is `reviewedAt`. An overturned send-back becomes payable at the overturn,
    so `reviewedAt` is set to that time: the work shows in the current period
    and never in one that was already paid. An overturned fix was accepted and
    payable since the original review, so its `reviewedAt` stays; moving it
    would take it out of a period that may be paid and pay it again. The
    original decision, its reviewer and its date stay on the `Review` row and
    on the `Dispute`;
  - `projectQuality` counts every review row (`reviewed`, `approved`,
    `sentBack`, QA scores) and `reviewerStats` counts decisions. Both leave
    overturned rows out. `myStats` groups by `reviewStatus` and follows;
  - `loadExportTasks` in `models/export.server.ts` exports the QA score of
    the last review that has one (`qa_score` in JSONL and CSV). An overturned
    review must not supply it;
  - the pages that show the latest review read `reviews[0]` for feedback and
    score: `routes/my-work.tsx`, `routes/my-work-revise.tsx` and
    `routes/project-annotator.tsx`. They show the outcome of the dispute
    instead. The full histories in `routes/review.tsx` and
    `routes/task-detail.tsx` keep the row and mark it as overturned.
- Upholding changes nothing but the status. The annotator sees the note.
- Tricky: sent-back work can be revised while a dispute is open
  (`resubmitAssignment` puts it back to `PENDING`). Make it one or the other:
  an open dispute hides "Revise" and `resubmitAssignment` refuses.
- Tricky: limits. One dispute per decision, only within 14 days of the review,
  and never on your own decision or your own work.
- Tricky: the reviewer should see the outcome too, for example an "overturned"
  number beside "sent back" and "fixed" on their dashboard.
- Not covered: gold scores, which no reviewer decided (item 10 lets a manager
  fix a wrong gold answer), and low QA scores on approved work.
- Undecided: who resolves. Anyone with the `review` capability except the
  reviewer who decided, or managers only. I lean towards the first, so a
  project with two reviewers does not wait for a manager.
- Tests: a new `tests/integration/disputes.test.ts` (who may open and resolve,
  an overturned fix restores the annotator's answer in the consensus and the
  export and drops its QA score there, an overturned send-back completes the
  task and is payable from the overturn, an overturned fix keeps its date,
  upheld changes nothing, no revise while open) and
  `tests/unit/outcome.test.ts` for `finalAnswer`.

### 10. Gold tasks: add, fix and rescore

Gold tasks can only be created with a `_gold` column at import (`createBatch`
sets `isGold` when the row has one). After that they are frozen:
`routes/task-detail.tsx` has no action at all. A gold answer that turns out to
be wrong keeps marking good annotators down, and can put them on the "needs
attention" list, until the batch is deleted, which `deleteBatch` refuses once
anyone has worked on it. Annotators only ever see one number, "Gold accuracy"
on the dashboard, and never which tasks they got wrong.

- Actions on the task page for managers (`manageProjects`):
  - edit the gold answer in the normal interface. Pairwise gold is only a
    preference (`parseGold` stores empty scores and rationale), so it needs
    its own small form, not `validatePairwise`;
  - retire a gold task: it is no longer handed out and its scores stop
    counting (probably a `goldRetiredAt` on `Task`, checked in `eligibleFor`
    and wherever `goldScore` is averaged);
  - "Use as gold" on a completed task with a consensus. This makes a copy
    (same `data`, `goldAnswer` from the consensus, in a batch named "Gold")
    and leaves the original alone, because gold tasks are left out of the
    export (`isGold: false` in `loadExportTasks`) and the original's labels
    are real data.
- Rescore after an edit: recompute `goldScore` for every submission of that
  task with `scoreAgainstGold`, the call `submitAssignment` makes, in one
  transaction, and log an activity entry with the old and new answer.
  `describe()` in `routes/project-activity.tsx` needs the new action names.
- For annotators: gold submissions show as "Accepted" in `routes/my-work.tsx`,
  like any work that needed no review. Show the score there, and on
  `/my-work/:assignmentId` reuse the comparison built for reviewer corrections
  (the `compare` mode of `routes/my-work-revise.tsx`, which its loader only
  allows for `SENT_BACK` and `FIXED` work today) with the expected answer on
  the right. A project setting turns this off.
- For managers: a small table on the quality page of the gold tasks with the
  lowest average score. A gold task that most people miss is usually the one
  that is wrong.
- Tricky: where a new gold task appears. `createBatch` appends after the last
  position and the queue goes strictly by `position`, so a copy made today
  would be served after everything else. `position` is not unique: give the
  copy a random position among the project's open tasks. Item 12 makes gold
  spacing a proper setting.
- Tricky: `listBatches` counts gold tasks in a batch's total, but gold tasks
  never complete, so a batch with gold never reads as done. Count them
  separately, as `projectProgress` does.
- Tricky: qualification questions carry a `goldAnswer` too. Editing one should
  not regrade past attempts: `scorePercent`, `passed` and `qualifiedAt` are
  stored results. Say so on the page.
- Tricky: the gold answer must not reach the browser before the submission.
  The work loader sends `task.data` only. Keep a test for it, like the one for
  the qualification page.
- Undecided: showing the expected answer lets annotators tell each other which
  tasks are gold. Each person meets a gold task only once, so I lean towards
  showing it by default.
- Tests: `tests/integration/gold.test.ts`: edit and rescore, retire, copy from
  a completed task, permissions, what the annotator's page shows.

### 11. Low-agreement tasks: extras and adjudication

When a task has `overlap` accepted answers it is complete, whatever they say.
`refreshTaskStatus` stores the merged answer and an agreement score, and when
the annotators split evenly (`classificationConsensus` and `pairwiseConsensus`
return `answer: null` on a tie) it stores no consensus and marks the task
`COMPLETE` anyway. On a single-label project with an overlap of 2, every
disagreement is a tie. The export then has `"consensus": null` for those tasks
and no page lists them.

- Settings on `Project`: `agreementThreshold Float?` (empty means off) and
  `maxExtraAnnotators Int @default(0)`, both in `projectFormSchema` and
  `ProjectForm`.
- Extra annotators: when a task reaches its answers but has no consensus or is
  under the threshold, and extras are left, it gets one more slot instead of
  completing. Data: `extraSlots Int @default(0)` on `Task`.
  `refreshTaskStatus` compares with `overlap + extraSlots`, and so does
  `eligibleFor` in `models/queue.server.ts`, which receives the overlap as SQL
  from three places (`nextCandidate`, the re-check inside the claim
  transaction, `countAvailable`).
- Adjudication: when no extras are left and the task is still split, it gets a
  new `TaskStatus`, `ADJUDICATION`. A new tab and list
  (`routes/project-adjudication.tsx`, capability `review`) shows those tasks,
  oldest first. The decision is made on the task page, which already renders
  every submission read-only: "Use this answer" on one of them, or an editable
  interface for a final answer of one's own, checked with `validateAnswer`.
  It stores `consensus`, `adjudicatedById` and `adjudicatedAt` on the task and
  completes it.
- Places that assume two statuses: the `STATUSES` filter in
  `routes/batch-detail.tsx`, `listBatches`, `projectProgress` and the progress
  bars built on them.
- The JSONL export says where a consensus came from (`majority` or
  `adjudicated`), and the quality page counts both.
- Tricky: `refreshTaskStatus` runs after every review decision and rewrites
  the consensus. It must leave an adjudicated task alone.
- Tricky: one threshold means different things. For classification and
  pairwise the agreement is the share behind the top vote (0.5 for one against
  one, 0.67 for two against one). For entities and boxes it is the mean F1
  between annotators. The form has to explain this next to the field. With an
  overlap of 1 there is nothing to compare.
- Tricky: nobody may adjudicate a task they answered themselves. Admins can
  annotate, so this can happen.
- Tricky: an extra slot can stay empty for ever when every member has already
  answered the task. Managers should be able to adjudicate an open task with
  disagreeing answers from its page without waiting.
- Item 12 changes `eligibleFor` too. The two changes are independent, but
  whoever lands second has to merge them.
- Undecided: whether an adjudicated answer should feed back into the
  annotators' numbers (agreement with the adjudicator, per person). I lean
  towards not yet.
- Tests: `tests/integration/review.test.ts` has a "consensus on completion"
  block to extend: a tie opens an extra slot, the third answer settles it, no
  extras left sends it to adjudication, an adjudicated task survives a later
  review, the export marks the source.

### 12. Queue order and assignment rules

The queue has one rule: the open task with the lowest `position` that you have
not touched and that has a free slot (`nextCandidate` in
`models/queue.server.ts`). Position is import order. So an urgent batch
imported later waits behind everything before it. Everyone works through the
file in the same order. Gold tasks sit wherever their rows were in the file,
so a block of gold at the top is done in the first ten minutes and never met
again. One fast annotator can label most of a project. And a claim somebody
walked away from blocks its slot until the time limit runs out, which can be
eight hours (`timeLimitMinutes` goes up to 480), or sixteen with the
extension. A manager sees it under "Claims" on the task page and cannot
release it.

- Batch priority and pause: `priority Int @default(0)` and
  `pausedAt DateTime?` on `Batch`. `nextCandidate` joins the batch and sorts
  by priority first; `eligibleFor` skips paused batches. Controls on
  `routes/batch-detail.tsx` (new intents beside `delete`), shown in
  `routes/project-batches.tsx`, with activity entries.
- Order inside a priority: a project setting, import order or shuffled.
  Shuffled has to be stable for one annotator and different between them, for
  example `ORDER BY md5(t.id || userId)`.
- Gold spacing: a project setting `goldEvery` ("about one gold task in every
  N"). `claimNextTask` counts the annotator's submissions since their last
  gold task, and when one is due and an unseen one exists it serves that,
  otherwise a regular task. Some jitter keeps it from being exactly every Nth.
  Empty means today's behaviour.
- A daily limit per annotator (`dailyTaskLimit` on `Project`, counted per UTC
  day like "done today" on the work page). `ClaimResult` gets a `limit`
  reason and `lib/queue-messages.ts` a text for it; the redirects already pass
  the reason through.
- Managers can release an active claim from `routes/task-detail.tsx`. It sets
  `RELEASED`, like `releaseAssignment` without the owner check. The annotator's
  open page then gets "This task is no longer yours" on submit, which exists.
  That route has no action today, and items 10 and 11 add theirs to it as
  well.
- Tricky: `countAvailable` feeds "N tasks available" and the Start button on
  the dashboard. It must apply the same rules, or the dashboard offers work
  that the claim then refuses.
- Tricky: eligibility is evaluated three times per claim (the candidate query,
  the locked re-check, the count). The choice between gold and regular has to
  sit inside the retry loop of `claimNextTask`.
- Tricky: no index serves a shuffled order, so every claim sorts all eligible
  tasks. Fine for thousands of tasks, not for hundreds of thousands (item 17).
- Tricky: with default settings the behaviour must stay exactly as it is. The
  queue tests rely on position order.
- Undecided: assigning tasks to named people by hand. That is a different
  model (`assignedToId` on `Task`) and I do not think it is needed while
  claims work.
- Tests: `tests/integration/queue.test.ts`, with the random source passed in
  as `now` is today.

### 13. Moving, resizing and zooming boxes

A box can be drawn, relabelled and deleted, and that is all. One that is a few
pixels off has to be deleted and drawn again. The image is scaled to fit the
window (`max-h-[70vh]`), so small objects are a few screen pixels wide. And
there is no undo: Delete on the wrong box is final.

- Everything is in `components/labeling/bounding-boxes.tsx`: an `<img>` under
  an SVG overlay in image coordinates, `toImage()` to convert pointer
  positions, pointer capture on the SVG, and `selected` as an index into the
  list of boxes.
- Move by dragging a selected box, resize with eight handles. The maths goes
  into `domain/geometry.ts`, which has only `iou` and `round` today:
  `moveBox`, `resizeBox` (flipping when a handle is dragged past the opposite
  edge) and clamping to the image and to `minBoxSize`. The server needs no
  change: `validateBbox` already clamps and rounds.
- Keyboard: every box can take focus, so Tab walks through them. While a box
  has focus the arrows nudge it by one image pixel, with Shift by ten, and
  another modifier resizes. `n` drops a new box in the middle of the view, so
  the tool works without a pointer. Elsewhere the arrows keep their native
  meaning, for example in a radio group (items 3 and 8).
- Zoom and pan: wheel or `+` and `-` around the pointer, drag with Space held
  to pan, `f` to fit. Not `0`: that is the tenth label (item 3). Read-only
  views (review before "Fix it myself", the task page, the comparison) get
  zoom too.
- These keys go into the one key map in `domain/hotkeys.ts` that item 3
  describes, so the help list shows them and the test for keys used twice
  covers them. Label letters skip `n` and `f`. If the module does not exist
  yet, create it in that shape with the keys of this item.
- `useHotkeys` needs two changes. It passes only `event.key` and drops
  anything pressed with Ctrl, Meta or Alt, so it has to hand over the event.
  And `isTyping` stops it for every `INPUT` element, radios and checkboxes
  included; it must stop only for text inputs, textareas, selects and editable
  content. Items 3 and 8 need that second change too; whichever of the three
  lands first makes it.
- Undo and redo (`Ctrl+Z`, `Ctrl+Shift+Z`): a small history reducer in
  `domain/` (past, present, future, capped) that `NerSpans` can use as well.
  A whole drag is one entry.
- Tricky: pointer handling. Today a press on the SVG background starts a box
  and a press on a `<g>` selects one. With moving and resizing there are three
  kinds of drag, boxes overlap, and `pointercancel` is not handled.
- Tricky: `selected` is an array index and the boxes are keyed by index. Undo,
  redo and delete shift the array. Give boxes ids in the browser; they do not
  need to be sent, `validateBbox` rebuilds each box from `x`, `y`, `w`, `h`
  and `label`.
- Tricky: stroke width and label size come from `size.w / 400`, and the
  handles will too. With zoom they have to be divided by the zoom factor to
  stay the same size on screen. `toImage()` reads the SVG's bounding box, so
  it stays correct under a CSS transform.
- Tricky: on a tablet, dragging scrolls the page unless the SVG sets
  `touch-action: none`.
- Tests: unit tests for `moveBox`, `resizeBox` and the history (there is no
  `tests/unit/geometry.test.ts` yet). Pointer behaviour needs the DOM test
  setup from item 8, and jsdom has no layout, so keep the maths pure.

### 14. Image classification

The only image kind is boxes. Sorting images into classes (is there a person
in it, is this product photo usable, which category) is as common as boxes and
much simpler, and today it can only be faked by putting an image URL into a
text field.

- A new kind, `image_classification`, with `imageField`, `labels` and
  `multiple`. The answer is the existing `ClassificationAnswer`, checked by
  `validateClassification`, merged by `classificationConsensus` and scored
  against gold with the same label overlap. Loosen the parameter types that
  name `TextClassificationSchema`.
- The steps are in "Adding a labeling kind" in `docs/architecture.md`. That
  list says TypeScript points at every place. It does for the `switch`
  statements. It does not for these, which the list leaves out and should
  gain:
  - `taskPreview` in `domain/preview.ts` and the same three-way choice in
    `routes/batch-detail.tsx` (which field to show and search);
  - `categorical` in `models/quality.server.ts`, which names two kinds instead
    of asking `categoricalValue`;
  - the image check in `parseImport` (`schema.kind === 'bbox'`);
  - `KIND_NAMES` in `lib/format.ts`, a second copy of `KIND_LABELS` in
    `domain/task-schema.ts`, keyed by the Prisma enum;
  - the `kinds` map in `createTestProject` (`tests/integration/helpers.ts`).
- The interface: the image, then the label buttons. Take the button group out
  of `text-classification.tsx` so both kinds share it, including its number
  keys.
- The demo gets a fifth project (the README promises one per kind). The street
  images in `public/demo/` can be reused.
- Tricky: images are plain URLs that the annotator's browser loads
  (`isImageRef` accepts http(s) and paths on this site). A dead link shows the
  alt text and nothing else; `BoundingBoxes` has no `onError` either. Show a
  clear "image did not load" state and point to Skip, which already has
  "Content is broken or unreadable".
- Tricky: `TaskContext` hides `width` and `height` from the context list
  because box imports use them. Harmless here, but check what an image row
  shows.
- Not here: uploading images. The app stores no files.
- Undecided: a new kind, or an optional `imageField` on `text_classification`.
  I lean towards the new kind: `kind` picks the interface everywhere, and the
  Prisma enum (`TaskKind`, with a migration) keeps lists and filters simple.
- Tests: the unit test files for schema, answers, consensus, gold, export and
  template each get the new kind; one integration test that imports, labels,
  completes and exports an image project.

### 15. Audit trail

The activity tab records what managers did to one project, and only part of
it. Nothing is recorded outside projects: who changed a role, who set whose
password, who downloaded the labels or the pay report. A "settings" entry does
not say what changed. Resetting someone's qualification is not logged at all
(the `reset-qualification` branch in `routes/project-members.tsx`), and
neither is creating a project. The tab shows the latest 100 entries
(`listActivity`) and older ones cannot be reached.

- Data: `Activity` gets a required `orgId` (filled from the project in the
  migration) and `projectId` becomes optional. `logActivity` in
  `models/activity.server.ts` takes the organisation; every caller has it.
- New events: project created (`routes/project-new.tsx`), qualification reset,
  person added, role changed (from, to), password set by an admin, person
  removed (the actions in `routes/people.tsx`), own password changed
  (`routes/account.tsx`), sign-in and lockout (`routes/login.tsx`), and the
  three downloads (`routes/project-download.ts`,
  `routes/project-quality-export.ts`, `routes/payouts-export.ts`).
- Settings changes say what changed, in one shape shared with item 2: the
  `detail` of a `project.settings` entry holds `changes`, a map from field
  name to `[before, after]`, for example `changes: { rateCents: [8, 10] }`.
  `schema` holds the two schemas as JSON; item 2 writes that key, and if it
  has not landed, write it here the same way. `instructions` holds the two
  lengths of the text, not the text. `updateProject` already reads the project
  before saving, for the instructions check; read the other fields there too
  and compare.
- A page `/audit` for admins (`requireRole`, a link in
  `routes/app-layout.tsx`) with filters for person, action, project and date
  (`readRange`), pages (`paginate`) and a CSV download (`toCsv`). The project
  tab gets pages too.
- `describe()` in `routes/project-activity.tsx` turns an action into a
  sentence and falls back to the raw action name. Move it somewhere both pages
  can use it and cover every action.
- Tricky: never store secrets. A password event records who and whose,
  nothing else.
- Tricky: `actor` is required and deleted with the user (`onDelete: Cascade`).
  An audit row should outlive the account: make it optional with `SetNull` and
  keep the actor's name on the row.
- Tricky: `member.added` is written before the upsert, also when the person
  was already a member. Log after, and only when something changed.
- Tricky: a failed sign-in for an unknown email has no user and no
  organisation. Log lockouts for known accounts only, or the table becomes a
  place anyone can write to.
- Review decisions and submissions are rows already (`Review`, `Assignment`).
  Do not copy them into the log.
- Undecided: how long to keep entries. I lean towards for ever, until size is
  a problem.
- Tests: `tests/integration/projects.test.ts` has "lists what managers did on
  the activity tab" to extend; `tests/integration/people.test.ts` for the
  organisation events; a new test file for the page, its filters and the
  admin-only rule.

### 16. API tokens and a JSON API

Everything goes through the browser. `docs/routes.md` says it plainly: there
is no separate JSON API. A pipeline that wants to push tomorrow's tasks or
fetch finished labels has to log in with a password, keep a session cookie and
post forms. I want tokens that I create and revoke on the account page, and a
small versioned API for the things a script needs.

- Data: `ApiToken`: `userId`, `orgId`, `name`, `tokenHash` (SHA-256, unique),
  `prefix` (to recognise it in the list), `readOnly`, `createdAt`,
  `lastUsedAt`, `expiresAt`, `revokedAt`. The token is random bytes behind a
  fixed prefix such as `lp_` and is shown once.
- `requireApiUser(request)` in `lib/auth.server.ts` reads the
  `Authorization: Bearer` header, looks the hash up and returns the same
  `CurrentUser` shape as `requireUser`, so
  `requireProject(current, id, capability)` and `can()` work unchanged. The
  token has its user's current role; the membership is read on every request,
  as `getCurrentUser` does.
- Routes are listed by hand in `routes.ts`. New resource routes under
  `api/v1/`, like `routes/healthz.ts`:
  - `GET /api/v1/projects` and `/api/v1/projects/:id`, with the numbers from
    `projectProgress`;
  - `POST /api/v1/projects/:id/batches`: the body is a CSV or JSONL file. It
    goes through `parseImport`, `createBatch` and `logActivity` like the form,
    with the same limits, and answers with the same `{ line, message }`
    errors;
  - `GET /api/v1/projects/:id/export`: the same output as the download route.
    Move the body of the loader in `routes/project-download.ts` into a
    function both call;
  - `GET /api/v1/projects/:id/tasks?externalId=`: status, consensus and
    agreement of one task.
- Tokens are managed on `/account`. `routes/account.tsx` has one form and no
  `intent` today; it gets create, list and revoke.
- `docs/api.md` with curl examples, and a corrected sentence in
  `docs/routes.md`.
- Tricky: errors. `requireUser` redirects to `/login`, and `requireProject`
  throws text responses (`notFound`, `forbidden` in `lib/http.ts`). The API
  answers JSON with 401, 403 and 404, never a redirect.
- Tricky: keep the two ways in apart. No cookies on `/api` (a cookie there is
  a cross-site request waiting to happen) and no tokens on pages.
- Tricky: a retried upload doubles a batch. External ids are only unique
  within one file (`seenIds` in `parseImport`), in the UI as well. Accept an
  `Idempotency-Key` header, store it on `Batch` and answer a repeat with the
  first result.
- Tricky: writing `lastUsedAt` on every request is a write per read. Update it
  at most once a minute.
- Tricky: `makeRequest` in `tests/integration/helpers.ts` builds cookie and
  form requests only. It needs headers and raw bodies. `MAX_UPLOAD_BYTES` is
  exported from a route module (`routes/batch-new.tsx`) and should move next
  to `MAX_IMPORT_ROWS`.
- Rate limiting with the `RateLimiter` from `lib/rate-limit.server.ts`, keyed
  by token. It is in memory and per process, like the login limiter.
- Undecided: webhooks (a POST to a URL when a batch completes) so scripts need
  not poll. I lean towards a later item. Scopes beyond `readOnly`: not yet.
- Tests: a new `tests/integration/api.test.ts`: no token, revoked, expired,
  read-only on a write, another organisation's project is 404, import and
  export round trip, a repeated key creates one batch.

## Maybe

### 17. Faster on large projects

I have only run this with a few thousand tasks. Several paths load a whole
project into memory or walk it on every request, and an import stops at 5,000
rows (`MAX_IMPORT_ROWS`) and 5 MB. I do not know that anyone needs more, which
is why this is here and not above. What would have to change first:

- Export: `loadExportTasks` reads every task with its assignments and reviews
  in one query, the writers in `domain/export.ts` build one string and
  `routes/project-download.ts` returns it. Page through the tasks by
  `position` and return a stream. JSONL and CSV become one task at a time.
  COCO has global lists and ids, and the zip formats from item 6 need a
  streaming writer.
- Quality: `projectQuality` loads every submitted and skipped assignment, with
  answers and reviews for categorical projects, on each view of the page and
  again for `quality.csv`. The counts per annotator can be one `GROUP BY`, as
  `dailyThroughput` already does with `$queryRaw`. Kappa needs one value per
  annotator and task, not the whole answer.
- Claiming: `eligibleFor` runs a `NOT EXISTS` and a `count(*)` for each
  candidate, in position order, until one passes. Tasks that are full but not
  complete (waiting for review) are checked again on every claim. With 50,000
  of those in front of the first free task, each claim reads them all. A
  count of taken slots on `Task`, kept up to date wherever an assignment is
  created, skipped, released or expired, would let an index answer the
  question.
- Import: `createBatch` is one `createMany`, which is fine for 5,000 rows.
  Raising the cap means inserting in chunks and reading the upload as a
  stream; the action calls `file.text()`.
- Lists: `routes/project-annotator.tsx` shows a person's latest 50 entries
  with no pages.
- Tricky: the counter is a second source of truth for the queue. Expiry is
  lazy (`releaseExpiredClaims` is one `updateMany` at the next claim), so the
  counter has to drop in that same statement. A test should run a random
  series of claims, skips, releases, expiries and reviews and then compare
  every counter with a fresh count.
- Tricky: proving it in CI. Timing on a shared runner is noise. Build a
  fixture of some 20,000 tasks with `createMany` and assert on work done: rows
  read by the claim query, from `EXPLAIN (ANALYZE, FORMAT JSON)`, and rows
  fetched per export page.
- Depends on item 12: the faster claim has to keep whatever ordering rules
  exist by then. Items 6 and 11 touch the same export and queue code.
- Undecided: how much of this to do without a real large project. Streaming
  export and SQL aggregates are plain wins. The counter adds a way for the
  queue to be wrong, and I would only add it with the consistency test.

### 18. Pre-labeling hook

Tasks could arrive with a suggested answer, so annotators correct instead of
starting from nothing: entities from a name list, a sentiment label from a
keyword rule, or the output of whatever model the project owner runs
elsewhere. Other tools get a lot of speed from this. I am not sure about the
price: people accept what is already filled in.

- Two sources of suggestions:
  - a `_prediction` column in the import file, read like `_gold` (`parseGold`
    in `domain/gold.ts` already accepts the short forms). This covers any
    model that ran outside the app;
  - rules that run in the app at import. A new `domain/prelabel.ts` with one
    function type, `(schema, data, config) => Answer | null`, and a registry
    by name. It ships with two rule-based entries and calls no service:
    keyword lists for classification, and phrase lists per entity type for
    spans (longest match first, no overlaps, because `validateNer` refuses
    overlapping spans).
- Data: `suggestion Json?` on `Task`, `prelabel Json?` on `Project` (which
  rule and its lists, checked with zod like the task schema) and
  `fromSuggestion Boolean` on `Assignment`. `ImportRow` and `createBatch`
  carry the suggestion.
- The work loader (`routes/work.tsx`) sends the suggestion and the interface
  starts from it. A draft from item 1 wins when both exist.
- That only works when the page starts fresh for each assignment. Today `Work`
  is not remounted between tasks and `answer` carries over from the previous
  one, so the next task's suggestion would never be shown. Item 1 fixes this
  by rendering the page body under `key={assignment.id}`; if this item lands
  first it has to do the same.
- Never for gold or qualification tasks. A gold task with a suggestion either
  gives the answer away or tests whether people fix it, and neither is what
  gold accuracy means today.
- On the quality page: for each annotator, the share of suggestions submitted
  unchanged and the time spent on them. And for the rule itself: run it over
  the gold tasks without showing the result to anyone, and report its score
  against the gold answers with `scoreAgainstGold`. That measure costs
  nothing.
- Tricky: anchoring. The submit button is enabled as soon as there is an
  answer (`disabled={busy || !answer}`), so a pre-filled task is one keypress.
  Show a suggestion as a suggestion (dashed, labelled) and require an explicit
  accept or an edit before submitting.
- Tricky: agreement is inflated. All annotators of a task see the same
  suggestion, so kappa and the consensus lean towards it. At least say so on
  the quality page.
- Tricky: patterns written by managers. A regular expression can hang the
  server during an import. Start with literal phrases and word lists and cap
  their number and length.
- The export should say which annotations started from a suggestion and carry
  the suggestion itself, so its effect can be measured later.
- Undecided: show the suggestion to every annotator of a task or only to the
  first. Only the first keeps the others independent, and makes the queue care
  about who came first. I lean towards everyone, with the note on the quality
  page.
- Tests: `tests/unit/prelabel.test.ts` for the rules; integration tests for an
  import with `_prediction`, rules applied at import, no suggestion on gold
  tasks, and what a submission records.
