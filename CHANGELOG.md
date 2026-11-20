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

### Importing and labeling

- Drafts: the work page saves the answer in progress and the working time to
  the server a moment after each change and when the tab is hidden or closed,
  and a reload continues from there. Revising sent-back work keeps a draft the
  same way; the qualification test keeps its answers in the browser tab. What
  is kept in the tab belongs to one user and is removed on sign-out
- Import reads tab-separated files, semicolon CSV files and JSON arrays next
  to CSV and JSON Lines, and takes a quote inside a field as text
- A file is imported completely or not at all. The option to skip invalid
  rows is gone; the refusal lists the first 20 problems and counts the rest
- An upload is cut off at 5 MB instead of being read first, and zip and gzip
  files are refused without being unpacked
- Image addresses for box projects have to be http or https URLs or a path on
  the portal; `//host` addresses are refused now. The server never fetches
  them. Addresses inside a network (loopback, private, link-local and
  reserved IP addresses, names without a dot or under `.local`) are refused
  too, unless the installation lists the host in `INTERNAL_IMAGE_HOSTS`
- An import is refused when a quoted field is never closed (naming the line
  where it opened), or when a row nests more than 32 levels deep or holds more
  than 10,000 values. A bad gold answer in a re-imported CSV export is
  reported on its own row
- A gold answer for a comparison may only be a tie where the schema allows
  ties, and a batch is refused when the schema changed while its file was
  read
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
  paid on hourly projects. It is saved with the revision draft, so a reload
  does not lose it. A revision is credited at most the project's time limit,
  and a task at most three time limits in all. A person's time is credited
  once: the stretches of their time already credited are kept, and any
  submission or revision is credited only the time of its own window that no
  other work took, so several sent-back submissions handed in together, or a
  revision made while a claim is held, do not pay the same minutes twice,
  whatever order they are handed in
- New export formats: YOLO and Pascal VOC (a zip with one file per image) for
  box projects and CoNLL BIO tags for entity projects
- Exports name annotators by a pseudonym that is stable within a project.
  `annotators=email` in the download address gives the email address as
  before
- Exports are written as a stream, task by task, so a large project no longer
  has to fit in memory
- The CSV export has three more columns at the end (`submitted_at`, `answer`,
  `data`), and a cell that starts with `=`, `+`, `-` or `@` gets a quote in
  front so that a spreadsheet does not run it. The payout and quality CSV
  files are guarded the same way
- The JSON Lines and CSV exports can be imported again: tasks come back with
  their data and external id, and the consensus as the gold answer

**Upgrade note.** The day work became payable is stored from this version on
(`Assignment.payableAt`). The migration sets it to the submission date for
every piece of work that is already accepted when the migration runs, so
every past pay report is unchanged: a period that was paid shows the same
total as before, and nothing in it is owed again. Work accepted after the
upgrade gets the new rule: the review date, the submission date where no
review was needed, or the date of the overturn for a send-back that a dispute
overturned. Work submitted before the upgrade and approved after it counts in
the period of its approval.

### Operations

- Audit trail: every change managers, reviewers and admins make to projects,
  settings, pay, schema, batches, members, qualification, gold tasks,
  reviews, disputes and people is recorded in the same transaction as the
  change, and so are sign-ins, lockouts of known accounts and the three
  downloads. A settings entry says which fields changed, from what to what;
  the instructions as two lengths. Entries hold no passwords and no answers
- `/audit` for admins lists the whole organisation's trail with filters for
  person, action, project and days, in pages, with a CSV download. The
  project's activity tab has pages too
- Entries are never changed or removed: the database refuses it. They keep
  the actor's name and stay when the account or the project is deleted
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
