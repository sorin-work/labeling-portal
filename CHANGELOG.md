# Changelog

## Unreleased

### Projects and setup

- Schema edits are checked against stored work. The settings form refuses
  another kind or field name once tasks exist, removing or renaming a label,
  entity type or box label that answers use, turning off `multiple` or
  `allowTie` while answers depend on them, and a new rubric dimension that
  scored answers lack. It shows what an edit would do while typing, and the
  error says where the answers are stored and points to "Duplicate project"
  for a redesign
- A saved schema edit is recorded in the activity log with the schema before
  and after, and the activity tab says what changed
- Pairwise consensus averages only the dimensions of the current rubric,
  over the answers that have a score for them

### Review and quality

- Review sampling: a project can review a share of its submissions instead of
  all of them. The draw happens once at submission and is stored; each
  annotator's first ten submissions and all work of annotators flagged for low
  gold accuracy are always reviewed; work that is not drawn is accepted at
  once and can complete its task
- Reviewer reservations: "Start reviewing" reserves the oldest free submission
  for one reviewer for 15 minutes, the queue shows who holds what, and a
  decision on a submission someone else holds is refused. Two reviewers asking
  or deciding at the same moment can no longer end up on the same submission.
  The review page renews the hold while the reviewer works, so a long fix is
  not lost to the next reviewer
- Quality page and its CSV: share of each annotator's work that was reviewed

### Pay and export

- Earnings page: everyone sees their own pay for a date range, split into
  what is payable, what is waiting for review and what was sent back, with
  the rules it is counted by
- The rate and pay mode are frozen on a submission when it is made. Changing
  a project's rate no longer reprices earlier work, and a project whose rate
  changed shows one line per rate on the payouts page and in its CSV.
  Submissions from before this change were given their project's rate of the
  day of the upgrade
- Work now counts in the period it became payable: the day a reviewer
  approved or fixed it, or the day it was submitted when no review was
  needed. Before, it counted on the day it was submitted
- Time spent revising sent-back work is added to the active time, which is
  paid on hourly projects

### Operations

- A `backup` service behind a compose profile dumps the database once a day
  into `./backups` and keeps the newest seven dumps; `backup once` takes a
  dump right away and `backup restore <file>` loads one into a new database
  that takes the place of the old one in a single transaction, only when the
  load worked
- CI puts the demo data into the test database, dumps it, restores the dump
  into a scratch database and compares the row counts, and runs the daily
  loop and the pruning against made-up clocks

### Fixes

- A task could stay open for good with its overlap met when its last
  submissions were accepted at the same moment. The task is now locked while
  its accepted submissions are counted
- On a database whose time zone is not UTC, a task with a live claim could be
  handed to a second annotator, and the daily chart put submissions on the
  wrong day
- A work form posted twice around the time limit could turn the stored
  submission into an expired claim. Skipping and releasing are guarded the
  same way

## 1.0.0 - 2026-11-08

First stable release.

### Projects and setup

- Organisations with admin, project manager, reviewer and annotator roles
- Projects with Markdown instructions (live preview, raw HTML shown as text),
  a JSON task schema checked while typing, overlap, time limit, review on/off,
  per-task or hourly pay rate; launch, pause, archive and duplicate
- Project members with qualification status; activity log of manager changes
- People page for admins: add members, change roles, set a new password

### Importing and labeling

- CSV and JSONL import into batches with per-line errors, gold answers in a
  `_gold` column, qualification test batches and example files
- Labeling interfaces for text classification, named entities, pairwise
  comparison with a rubric and rationale, and bounding boxes, with keyboard
  shortcuts
- Task queue with claims, time limits, automatic release, one extension per
  claim, skip with a reason and release; claims are safe under concurrency
- Active time tracking per task

### Review and quality

- Review queue with approve, send back with feedback, or fix; QA scores;
  annotators revise returned work and compare corrections
- Consensus answers and agreement per completed task
- Quality page: per-annotator approval, QA score, gold accuracy, speed and
  throughput, Cohen's and Fleiss' kappa, skip reasons, daily throughput chart
- Gold tasks scored automatically; qualification tests before claiming work
- Needs-attention list for managers, stats for annotators and reviewers

### Pay and export

- Payouts report for a date range and project, with CSV download
- Label export as JSONL, CSV or COCO, per project or batch

### Operations

- Docker image and compose setup with PostgreSQL, health check and demo data
- GitHub Actions CI: lint, format, typecheck, unit and integration tests, build
