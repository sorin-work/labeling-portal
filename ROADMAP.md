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
| 14  | Image classification                         | Later   | labeling      | M    | -          |
| 15  | Audit trail                                  | Later   | ops           | M    | -          |
| 16  | API tokens and a JSON API                    | Later   | api           | L    | -          |
| 17  | Faster on large projects                     | Shipped | performance   | L    | 12         |
| 18  | Pre-labeling hook                            | Maybe   | labeling      | L    | -          |

## Next

## Later

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
  statements that have no `default`. It does not for these, which the list
  leaves out and should gain:
  - `categoricalValue` in `domain/agreement.ts`. Its `switch` ends in
    `default: return null`, so a new kind compiles and silently gets no kappa.
    Add the kind there by hand, with a case in
    `tests/unit/agreement.test.ts`;
  - `categorical` in `models/quality.server.ts`, which names two kinds instead
    of asking `categoricalValue`. Left alone, the quality page loads no
    answers for an image project and shows it the F1 tile;
  - `taskPreview` in `domain/preview.ts` and the same three-way choice in
    `routes/batch-detail.tsx` (which field to show and search);
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
- Tests: the unit test files for schema, answers, consensus, gold, agreement,
  export and template each get the new kind; one integration test that
  imports, labels, completes and exports an image project, and one in
  `tests/integration/quality.test.ts` that the quality page reports kappa for
  it.

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
- That only works because the page starts fresh for each assignment: since
  item 1 the page body is rendered under `key={assignment.id}`, so `answer`
  does not carry over from the previous task and can start from the
  suggestion.
- Never for gold or qualification tasks. A gold task with a suggestion either
  gives the answer away or tests whether people fix it, and neither is what
  gold accuracy means today.
- On the quality page: for each annotator, the share of suggestions submitted
  unchanged and the time spent on them. And for the rule itself: run it over
  the gold tasks without showing the result to anyone, and report its score
  against the gold answers with `scoreAgainstGold`. That measure costs
  nothing.
- Tricky: anchoring. The submit button is enabled as soon as there is an
  answer (`disabled={busy || !toSubmit}`), so a pre-filled task is one keypress.
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
