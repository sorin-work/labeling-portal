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
| 6   | More import and export formats               | Next    | import/export | M    | -          |
| 7   | Scheduled backups                            | Shipped | ops           | S    | -          |
| 8   | Accessibility pass                           | Next    | ui            | M    | -          |
| 9   | Disputes on review decisions                 | Shipped | review        | M    | -          |
| 10  | Gold tasks: add, fix and rescore             | Shipped | quality       | M    | -          |
| 11  | Low-agreement tasks: extras and adjudication | Later   | quality       | M    | -          |
| 12  | Queue order, batch priority and gold spacing | Shipped | queue         | M    | -          |
| 13  | Moving, resizing and zooming boxes           | Shipped | labeling      | M    | -          |
| 14  | Image classification                         | Later   | labeling      | M    | -          |
| 15  | Audit trail                                  | Later   | ops           | M    | -          |
| 16  | API tokens and a JSON API                    | Later   | api           | L    | -          |
| 17  | Faster on large projects                     | Maybe   | performance   | L    | 12         |
| 18  | Pre-labeling hook                            | Maybe   | labeling      | L    | -          |

## Next

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

### 8. Accessibility pass

The basics are there: a skip link, visible focus, labelled navigation and form
fields, `role="alert"` on the time warning. I have never gone through the
labeling pages with only a keyboard or with a screen reader, and nothing in CI
checks any of it. Gaps I already know about:

- Entity spans can only be made with a mouse. `NerSpans` reads
  `window.getSelection()` on `mouseup`. Since item 3 a span can be selected,
  retyped and removed from the list under the text with the keyboard, but not
  made. It needs a keyboard path: while the text has focus, a cursor that the
  arrow keys move word by word, Shift with an arrow to extend, Enter to apply
  the active type.
- Boxes no longer need a pointer since item 13: `n` puts a new box in the
  view, Tab walks through the boxes, and the arrows move and resize the one
  that has focus.
- New keys go into the key map in `domain/hotkeys.ts` (item 3): pages and
  kinds, key to action, read by the handlers and by `KeyboardHelp`. The arrow
  keys and Space stay with a focused radio button or checkbox there
  (`isNativeKey`), so a cursor in the entity text needs its own rule.
- After "Submit and next" the next task loads without any announcement, and
  focus stays wherever it was. Move focus to the task, or announce it in a
  live region, in `routes/work.tsx`, and move focus to `<main id="main">` on
  navigation in `routes/app-layout.tsx`.
- `aria-sort` sits on the sort button in the quality table
  (`routes/project-quality.tsx`). It belongs on the `<th>`.
- The label buttons in `text-classification.tsx` have `role="radio"`, but
  each one is a tab stop and the arrow keys do nothing. Make the group behave
  like a native radio group: one tab stop, and the arrow keys choose. Real
  radio inputs give that for free; the pairwise score rows have been real
  radio groups since item 3. The preference buttons in `pairwise.tsx` and the
  quality score on the review page are `aria-pressed` buttons and want the
  same.
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

### 11. Low-agreement tasks: extras and adjudication

When a task has `overlap` accepted answers it is complete, whatever they say.
`refreshTaskStatus` stores the merged answer and an agreement score and marks
the task `COMPLETE`. On single-label and pairwise projects an even split has
no majority: `classificationConsensus` and `pairwiseConsensus` return
`answer: null`, and with an overlap of 2 every disagreement ends that way.
Multi-label, entity and box tasks always get a consensus, made of whatever a
majority shares, and it can be empty (no labels, no spans, no boxes). Either
way the export carries the result as it is, and no page lists the tasks people
disagreed on.

- Off by default. `agreementThreshold Float?` on `Project` is empty unless a
  manager sets it, and while it is empty nothing changes: every task completes
  exactly as today, tied ones included. `maxExtraAnnotators Int @default(1)`
  (0 to 3) only matters once a threshold is set. Both go into
  `projectFormSchema` and `ProjectForm`. Turning the setting on does not
  reopen tasks that are already complete.
- The rule is the same for every kind. Once a task has its required accepted
  answers, compare the agreement that `consensus()` in `domain/consensus.ts`
  already returns, and `Task.agreement` stores, with the threshold:
  - at or above it, the task completes as today;
  - under it, the task gets one more annotator, until `maxExtraAnnotators`
    extras have been used;
  - still under it after the last extra, the task goes to adjudication.
- Whether a majority exists plays no part in the rule. A two against one vote
  under the threshold is escalated like any other, and a tie is not a special
  case.
- The number is the one the app computes for each kind today:
  - single-label classification and pairwise: the share of annotators behind
    the most chosen label or preference (0.5 for one against one, 0.67 for two
    against one, 0.33 for three different answers);
  - multi-label classification: for each label that anyone chose, the share of
    annotators who chose it, averaged over those labels. `a` and `b` against
    `a` alone is (1 + 0.5) / 2 = 0.75;
  - entities: span F1 (same start, end and type), averaged over every pair of
    annotators;
  - boxes: box F1 (same label and an IoU of at least 0.5), averaged over every
    pair of annotators.
- So an even split scores 0.5 or less, and a threshold above 0.5 catches every
  tie on single-label and pairwise projects. Under a lower threshold a tied
  task still completes without a consensus, as today. The form explains the
  number for the project's kind next to the field. With an overlap of 1 the
  agreement is always 1 and the setting does nothing.
- Extra annotators. Data: `extraSlots Int @default(0)` on `Task`, raised by
  one each time. `refreshTaskStatus` in `models/tasks.server.ts` compares the
  accepted answers with `overlap + extraSlots`, and so does `eligibleFor` in
  `models/queue.server.ts`, which receives the overlap as SQL from three
  places (`nextCandidate`, the re-check inside the claim transaction,
  `countAvailable`). The consensus and the agreement are then computed over
  all accepted answers, extras included.
- Adjudication: a task that is still under the threshold after its last extra
  (or straight away when `maxExtraAnnotators` is 0) gets a new `TaskStatus`,
  `ADJUDICATION`. A new tab and list (`routes/project-adjudication.tsx`,
  capability `review`) shows those tasks, oldest first. The decision is made
  on the task page, which already renders every submission read-only: "Use
  this answer" on one of them, "Keep the consensus" when a majority produced
  one, or an editable interface for a final answer of one's own, checked with
  `validateAnswer`. It stores `consensus`, `adjudicatedById` and
  `adjudicatedAt` on the task and completes it.
- Places that assume two statuses: the `STATUSES` filter in
  `routes/batch-detail.tsx`, `listBatches`, `projectProgress` and the progress
  bars built on them.
- The JSONL export says where a consensus came from (`majority` or
  `adjudicated`), and the quality page counts both.
- Tricky: `refreshTaskStatus` runs after every review decision and rewrites
  the consensus. It must leave an adjudicated task alone. It must also raise
  `extraSlots` only when the accepted answers have reached
  `overlap + extraSlots`, so a second call with the same answers adds nothing.
- Tricky: nobody may adjudicate a task they answered themselves. Admins can
  annotate, so this can happen.
- Tricky: an extra slot can stay empty for ever when every member has already
  answered the task. Managers should be able to send a task that is waiting
  for an extra annotator to adjudication from its page.
- Items 10 and 12 have shipped conditions in `eligibleFor` that must stay.
  Item 12: a task in a paused batch is never eligible. Item 10: a retired gold task is never eligible
  (`t."goldRetiredAt" IS NULL`), and a task, the task it was copied from and
  that task's other copies are one group (the second `NOT EXISTS`, over
  `kin`): whoever has a claim, a submission or a skip on one of them gets
  none of the others. Gold tasks stay outside the slot count, extra slots
  included.
- Undecided: whether an adjudicated answer should feed back into the
  annotators' numbers (agreement with the adjudicator, per person). I lean
  towards not yet.
- Tests: `tests/integration/review.test.ts` has a "consensus on completion"
  block to extend. With the setting off, a tie completes without a consensus
  as today. With it on: a task under the threshold opens an extra slot even
  when it has a majority, a task at the threshold completes, the extra answer
  can settle it, a task still under after the last extra goes to adjudication,
  an adjudicated task survives a later review, and the export marks the
  source. One case per kind for the number that is compared.

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
- Schema edits: `schemaUsage` in `models/projects.server.ts` unnests every
  stored answer of the project in one statement, about two seconds at 200,000
  tasks, on every load of the settings page and again inside a save that
  changes the schema. Keep the counts per name up to date where answers are
  written, or count only when the schema field is edited. The second also
  shortens the window item 2 leaves open.
- Tricky: the counter is a second source of truth for the queue. Expiry is
  lazy (`releaseExpiredClaims` is one `updateMany` at the next claim), so the
  counter has to drop in that same statement. A test should run a random
  series of claims, skips, releases, expiries and reviews and then compare
  every counter with a fresh count.
- Tricky: proving it in CI. Timing on a shared runner is noise. Build a
  fixture of some 20,000 tasks with `createMany` and assert on work done: rows
  read by the claim query, from `EXPLAIN (ANALYZE, FORMAT JSON)`, and rows
  fetched per export page.
- Depends on item 12: the faster claim has to keep the ordering rules that
  item adds (batch priority and pause, shuffled order, gold spacing). Items 6,
  10 and 11 touch the same export and queue code without being needed first.
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
