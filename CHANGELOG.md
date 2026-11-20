# Changelog

## Unreleased

### Projects and setup

- Schema edits are checked against stored work. The settings form refuses
  another kind or field name once tasks exist, removing or renaming a label,
  entity type or box label that answers use, turning off `multiple` or
  `allowTie` while answers depend on them, and a new rubric dimension that
  scored answers lack. It shows what an edit would do while typing, and the
  error points to "Duplicate project" for a redesign
- A saved schema edit is recorded in the activity log with the schema before
  and after, and the activity tab says what changed
- Pairwise consensus averages only the dimensions of the current rubric

### Importing and labeling

- Drafts: the work page saves the answer in progress and the working time to
  the server a moment after each change and when the tab is hidden or closed,
  and a reload continues from there. Revising sent-back work keeps a draft the
  same way; the qualification test keeps its answers in the browser tab. What
  is kept in the tab belongs to one user and is removed on sign-out
- Shortcuts for every action, all from one key map: a key for every label (1
  to 9, 0 for the tenth, then letters, shown on the buttons), pairwise rubrics
  that can be typed (digits walk the score rows, the arrows choose inside a
  row), `s` for the skip form, and on the review page `s` for the feedback
  box, `e` for "Fix it myself" and Esc to cancel a fix. Ctrl+Enter hands in
  the task, or the skip while the skip form is open
- Approving by key takes two keys, `a` and then Enter, and any other key
  calls it off. Right after a decision the keys that decide wait a moment, so
  a held or repeated key cannot approve the next submission unseen
- Entity spans are selected with a click, get another type with a key and are
  removed with Delete or the × next to them. The last removal can be undone
- `?` lists the shortcuts of the page and the project's labeling kind, on the
  work, review, revise and qualification pages
- Shortcuts keep working while a radio button has focus, and work on keyboard
  layouts where the digits need Shift and on the number pad. On the
  qualification test they act on one question, the one that was clicked or
  holds the focus, and that question is marked
- Queue order: a batch has a priority and can be paused from its page
  (higher numbers are handed out first; a paused batch hands out nothing new,
  claims on it can be finished, and resuming continues where it was). A
  project can hand out tasks in import order or shuffled, in an order of each
  annotator's own that stays the same for them. "Gold spacing" makes each task
  an annotator gets gold with a chance of 1 in N, per annotator, never as the
  first task of a session, keyed with a secret per project so the timing
  cannot be worked out. The dashboard count leaves paused batches out.
  With the default settings the order is the same as before
- Boxes can be moved by dragging and resized from eight handles, and with the
  keyboard: Tab walks through the boxes, the arrows move the one that has
  focus (Shift for ten pixels), `r` makes them resize it, `n` puts a new box
  in the middle of the view. `r` is no longer a label key, so labels 24 to 30
  moved one letter on (`t` to `z` instead of `r` to `y`)
- Zoom and pan for box images: the wheel, `+`, `-` and `f`, buttons, and
  Space with a drag. Reviewers and managers get the same zoomable picture
  without the editing. Zoom is kept for the session and is never part of an
  answer
- Undo and redo for boxes (Ctrl+Z, Ctrl+Shift+Z and buttons): drawing,
  moving, resizing, relabelling and removing

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
- Disputes: an annotator can contest a send-back or a correction, once per
  decision and within a time limit set on the project. Anyone who can review,
  except the reviewer who decided, upholds or overturns it with a note. An
  overturned decision no longer counts in the consensus, the export, the
  quality numbers or the reviewer's stats, and the work counts as approved.
  Sent-back work cannot be revised while its dispute is open. The annotator
  can withdraw an open dispute, and a dispute that nobody but the deciding
  reviewer could settle is refused with a message that says why
- Disputes are on for existing projects from the moment this is deployed: the
  window defaults to 14 days, so every send-back and correction of the last
  14 days can be disputed at once. Set "Dispute window" to 0 in a project's
  settings to keep disputes off there

### Operations

- A `backup` service behind a compose profile dumps the database once a day
  into `./backups` and keeps the newest seven dumps; `backup once` takes a
  dump right away and `backup restore <file>` loads one into a new database
  that takes the place of the old one in a single transaction, only when the
  load worked
- CI puts the demo data into the test database, dumps it, restores the dump
  into a scratch database and compares the row counts, and runs the daily
  loop and the pruning against made-up clocks

- Gold tasks can be managed after import. A manager can change the expected
  answer with a reason (the old answer, who, when and why are kept), see what
  a rescore would change and apply it, retire a gold task and bring it back,
  and make gold tasks from completed tasks, one by one or several from the
  batch page. A rescore only changes gold scores: accepted work stays
  accepted and paid, and past qualification attempts are not regraded
- After submitting a gold task, annotators see their score and the expected
  answer. A project setting, "gold feedback", controls it. It is on for new
  projects and off for every project that exists when this is deployed,
  because turning it on shows annotators the expected answers of the gold
  tasks they have already submitted
- Nothing on the work page tells a gold task from any other. The page no
  longer gets any id of the task: it shows a short reference cut from the
  claim's id in place of the external id, and managers find a task by that
  reference on the task page and in the batch search. A gold copy is placed
  among the open tasks of a batch that is being worked on and is never handed
  to someone who labeled its original or an earlier copy
- Quality page: the gold tasks with the lowest average score. Batch progress
  no longer counts gold tasks and test questions, which never complete

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
- The work page starts fresh for every task: the previous task's answer and
  working time no longer carry over after "Submit and next". The review page
  does the same for the score, the feedback and an open fix
- Entity and box tasks with nothing to label could not be submitted: the
  button stayed off until something had been marked and removed again. The
  qualification test has a "Nothing to label here" button for such a question
- Box projects: the drawing layer no longer goes missing after a reload, when
  the image came from the browser cache before the page was ready

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
