# labeling-portal

A work portal for data-labeling teams. Project managers set up projects with
instructions and a task schema, import tasks, and watch quality and pay;
annotators claim tasks from a queue and label them; reviewers approve, send back
or fix the work.

- **Organisations and roles**: admin, project manager, reviewer and annotator,
  with every project scoped to its organisation
- **Projects**: Markdown instructions with live preview, a JSON task schema,
  annotators per task (overlap), time limit, review of everything, of a
  sampled share or of nothing, pay rate. The schema can still be edited once
  work exists: edits that would break stored answers are refused, and the
  form says why before the save
- **Five labeling interfaces**: text and image classification (single or multi-label),
  named-entity span highlighting, pairwise response comparison with a rubric
  (A vs B preference, 1-5 scores per dimension for both sides, written
  rationale) and bounding boxes on images
- **Keyboard shortcuts** for every action: a key for each label (1 to 9, 0,
  then letters), a rubric that can be typed, keys for skipping, reviewing and
  fixing, and a list of them behind `?` on every labeling page
- **Undo and redo** for entity spans and boxes (Ctrl+Z, Ctrl+Shift+Z)
- **Box editing**: move and resize boxes by dragging or with the arrow keys,
  zoom and pan the image, undo and redo. Reviewers and managers get the same
  zoomable picture without the editing
- **Accessible**: every labeling action works from the keyboard, entity spans
  included; radio groups are real radio groups; focus moves to the next task
  and changes are said aloud for screen readers; text meets 4.5:1 contrast.
  axe runs over the main pages in the tests
- **Import** CSV, TSV, JSON Lines or a JSON array into batches. A file goes
  in completely or not at all, with the lines that failed listed; example
  files and gold answers in a `_gold` column
- **Task queue**: claim the next task, time limits with automatic release of
  abandoned claims, up to three extensions per claim, skip with a reason,
  release.
  Managers give batches a priority or pause them, can shuffle the order for
  each annotator, can space gold tasks out ("about one in every N"), can set
  a daily task limit per person and can release a claim someone walked away
  from
- **Suggested answers**: a `_prediction` column in an import, or a project
  rule (keyword or phrase lists) that runs after the import, suggests an
  answer. Annotators see it as a suggestion and take it or not; it never
  counts as an answer
- **Drafts**: the answer in progress and its working time are saved to the
  server while an annotator works, so a reload or a closed tab loses nothing.
  For two minutes after "Submit and next" the annotator can take the last
  task back and revise it, while no reviewer has looked at it
- **Review**: approve, send back with feedback, or fix the answer; QA scores
  1-5; annotators revise sent-back work and see corrections. "Start reviewing"
  reserves a submission for one reviewer, for 15 minutes and for as long as
  they keep working on it, so two reviewers never work on the same one. The
  reviewer can let go of it sooner, and a manager can release it
- **Review sampling**: review a share of the work instead of all of it. New
  annotators and annotators with low gold accuracy are always reviewed.
  Reviewers can spot check work that was accepted unseen: a score, a verdict
  and feedback, counted apart and changing nothing about the work
- **Disputes**: an annotator can contest a send-back or a correction within a
  time limit set on the project. Someone other than the reviewer upholds or
  overturns the decision, and an overturned decision is undone everywhere it
  counted
- **Low agreement**: with an agreement threshold set on the project, a task
  whose answers agree less gets extra annotators (up to three), then goes to
  an adjudication list where a reviewer who did not label it picks or gives
  the final answer, with a reason. Off by default
- **Quality**: per-annotator reviewed share, approval rate, QA score, gold
  accuracy, speed and throughput; Cohen's and Fleiss' kappa; consensus answers
  per task
- **Gold tasks** scored automatically and a **qualification test** before an
  annotator may work on a project. Managers can correct a gold answer (with a
  history of who changed it and why), rescore the stored answers against it
  after seeing what that changes, retire a gold task, and turn completed
  tasks into gold. After submitting, annotators see how they did
- **Time tracking** of active time per task and a **payouts** report (per task
  or hourly) with CSV download. Each submission keeps the rate its project
  had when it was made, and work counts in the period it became payable
- **Earnings** page where everyone sees their own money: what is payable for
  a period and what is still waiting for review or was sent back
- **Export** of finished labels as JSON Lines or CSV (both can be imported
  again), COCO, YOLO or Pascal VOC for boxes and CoNLL tags for entities,
  with pseudonyms in place of annotator addresses
- **Notifications** inside the app (no mail): send-backs and corrections,
  disputes opened and settled, a changed gold score where gold feedback is
  on, a claim a manager released and changed instructions, with an unread
  count in the header
- **Audit trail**: every change managers, reviewers and admins make to
  projects, pay, schema, members, people, gold tasks, reviews and disputes,
  plus sign-ins, lockouts and downloads, on a project's activity tab and on
  `/audit` for admins with filters, pages and a CSV download. Entries are
  never changed or removed, and hold no passwords or answers
- **JSON API** under `/api/v1/` with tokens made on the account page:
  projects, batch upload with an `Idempotency-Key`, label export and task
  lookup. See [docs/api.md](docs/api.md)
- **Two-step sign-in** with an authenticator app (six-digit codes) and ten
  one-time recovery codes, set up on the account page. An admin can require
  it for admins and project managers (their API tokens too), and reset
  someone's second step on People; whoever lost their phone should change
  their password before asking for that
- **Sign out everywhere** on the account page, and **End sessions** for a
  person on People. A new password, set by an admin or by the person, signs
  out every other browser too. API tokens keep working and are listed with a
  way to revoke them
- Needs-attention list for managers, demo data

Ideas for what could come next are in [ROADMAP.md](ROADMAP.md).

## Stack

| Part    | Tech                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| App     | React Router 7 (framework mode, SSR), React 19, TypeScript                                        |
| Data    | PostgreSQL 17, Prisma 6                                                                           |
| Styling | Tailwind CSS 4                                                                                    |
| Tests   | Vitest: unit tests for domain logic, integration tests for loaders and actions against PostgreSQL |
| Tooling | ESLint, Prettier, GitHub Actions, Docker                                                          |

## Quick start with Docker

```bash
docker compose up --build
```

Open http://localhost:4421. On first start the database is migrated and a demo
organisation, _Harbor Data Labs_, is created with five projects (one per
labeling kind), a few weeks of reviewed work, gold tasks and a qualification
test. Every demo account uses the password `labeling-demo`:

| Email                    | Role            | Try                                                                                              |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `admin@example.com`      | Admin           | People, payouts, everything below                                                                |
| `pm@example.com`         | Project manager | Import a batch, quality, payouts, export, settle a dispute                                       |
| `reviewer@example.com`   | Reviewer        | Review queue of _Product review sentiment_ (a 50% sample)                                        |
| `annotator@example.com`  | Annotator       | Label tasks; take the qualification test for the pairwise project                                |
| `annotator2@example.com` | Annotator       | Qualified for the pairwise project, has returned work, and Earnings shows a project at two rates |
| `annotator3@example.com` | Annotator       | Lower gold accuracy, shows up in "needs attention"                                               |

Change the port with `WEB_PORT=8080 docker compose up`. The app is published
on 127.0.0.1 only; to serve it to others, put a proxy in front and set
`TRUST_PROXY=true`. Data lives in the
`db-data` volume; `docker compose down -v` starts fresh. For daily dumps of
that volume see [Backup and restore](#backup-and-restore).

## Local development

You need Node 22 and PostgreSQL 15+. The dev compose file starts just the
database (with a second `labeling_test` database for the tests):

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
npm install
npm run db:deploy
npm run db:seed
npm run dev              # http://localhost:4421
```

## Configuration

| Variable               | Default               | Purpose                                                               |
| ---------------------- | --------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`         | (required)            | PostgreSQL connection string                                          |
| `SESSION_SECRET`       | dev-only value        | Signs the session cookie; required (16+ characters) in production     |
| `COOKIE_SECURE`        | `true` in production  | Set `false` when serving over plain http                              |
| `SEED_DEMO`            | `false`               | Docker only: create the demo organisation on start                    |
| `SHOW_DEMO_LOGINS`     | `false`               | List the demo accounts on the sign-in page                            |
| `INTERNAL_IMAGE_HOSTS` | (empty)               | Internal hosts that box project images may come from, comma separated |
| `TEST_DATABASE_URL`    | local `labeling_test` | Database for integration tests (it is truncated between tests)        |
| `WEB_PORT`             | `4421`                | Host port for the compose setup                                       |
| `TOTP_KEY`             | dev-only value        | Encrypts the two-step secrets; required (16+) in production to use it |
| `TRUST_PROXY`          | `false`               | `true` behind a proxy: `X-Forwarded-For` names the client             |
| `JOBS_IN_WEB`          | `true`                | `false` leaves the background jobs to the `worker` service            |

## Background jobs

Work that runs after a request, today the suggestion rule over an imported
batch, is a row in the `Job` table, so a restart does not lose it and
several processes can share it. The app runs the job loop itself. To run it
in a process of its own, set `JOBS_IN_WEB=false` and start the `worker`
service, which runs the same image:

```bash
JOBS_IN_WEB=false docker compose --profile worker up -d
```

Both can run at once too: a job is only ever taken by one of them at a time.
A job that fails is tried again later, with a longer wait each time, and
after its last attempt it stays in the table with the error. On a stop the
loop takes no more jobs and lets the one it runs finish.

## Backup and restore

The label export leaves out reviews, gold answers, pay data, accounts and
project settings. For a full copy there is a `backup` service that dumps the
whole database with `pg_dump`. It is behind a Compose profile, so it only runs
when asked for:

```bash
docker compose --profile backup up -d
```

To have it start with every `docker compose up`, put `COMPOSE_PROFILES=backup`
in `.env`.

Dumps land in `./backups` as `labeling-<UTC date and time>.dump`. When the
service starts it makes one, unless the newest dump is less than a day old,
so restarting the stack does not add dumps. On a new stack it first waits for
the app to create the tables. After that it makes one dump a day. It looks at
the clock once a minute instead of sleeping for a whole day, so a machine
that was suspended or switched off catches up when it is back.

After each dump only the newest seven are kept. Files with any other name are
left alone: rename a dump to keep it for good. How old a dump is, and which
ones are the oldest, is read from the time in the file name and never from
the file's modification time.

A dump dated in the future is what a wrong clock leaves behind. Such dumps,
and dumps whose name holds a date that does not exist, are left out
everywhere:

- They do not say how old the newest dump is. The newest dump that is not
  dated in the future decides, so next to an older dump a new one is made at
  once. If every dump is dated in the future, the service waits a full day
  before its first dump instead of dumping at once.
- They are never removed automatically and do not count towards the seven.
  The dumps with a sane date get all seven places.
- Every start and every dump logs a warning that names them. Look at them
  and remove or rename them by hand.

| Variable                  | Default     | Purpose                               |
| ------------------------- | ----------- | ------------------------------------- |
| `BACKUP_DIR`              | `./backups` | Folder on the host the dumps go to    |
| `BACKUP_KEEP`             | `7`         | How many dumps to keep                |
| `BACKUP_INTERVAL_SECONDS` | `86400`     | Seconds from one dump to the next one |
| `BACKUP_STATUS`           | `on`        | `off` stops writing the status rows   |

After every dump, whether it worked or not, the service writes a row to the
app's `BackupRun` table, and admins see on the dashboard, under "Needs
attention", when the last dump failed or when there has been no good dump for
one and a half intervals (36 hours by default), with the newest good dump
under it. Before the service has written its first row nothing is said, so a
stack without the backup profile is not warned. A database without the table
yet (an older app, or one still migrating) gets no row and a line in the log;
the dump itself is not affected.

A row is written after its dump, so it is in the next dump and not its own.
After a restore the table ends at the dump before the one that was restored,
and the dashboard says so.

A dump right now, for example before an upgrade:

```bash
docker compose run --rm backup once
```

To restore, stop everything that uses the database, which is the app and the
backup service (and the worker, if you run it), name the dump, and start them
again:

```bash
docker compose --profile backup stop app backup
docker compose run --rm backup restore labeling-20261120T030000Z.dump
docker compose start app        # and backup, if you run it
```

`restore` without a file name lists the dumps. The restore replaces the whole
database, so everything written after the dump is gone. It goes in three
steps:

1. The dump is loaded into a new database, `labeling_restoring`. A damaged
   file stops here and the data in use was never touched.
2. The swap: the database in use is renamed to `labeling_replaced` and the
   restored copy takes its name, both in one transaction. There is no moment
   without a `labeling` database, whatever happens to the machine in the
   middle. PostgreSQL refuses the swap while anything is connected, so an app
   or a dump that is still running leaves the data as it was, and the message
   says who is connected.
3. Only then is `labeling_replaced` dropped.

A restore that was interrupted leaves a complete `labeling` behind, the old
one or the restored one, and possibly a `labeling_restoring` or
`labeling_replaced` next to it. The next restore removes those. The folder
with the dumps can be mounted read-only for a restore.

When the app starts again it applies any migrations that are newer than the
dump, so an older dump restored under a newer app is fine.

After losing the volume, or on another machine, it is the same command: put
the dump in `./backups`, run the `restore` line (it starts the database by
itself), then `docker compose up -d`.

Good to know:

- A dump holds the accounts with their password hashes, every answer and the
  pay data, and it is not encrypted. The files can only be read by their
  owner. On Linux that is the owner of the folder they are in, not root.
  Encrypting them is left to the disk (an encrypted volume or share): a
  passphrase in the service would be one more thing to lose, and a lost
  passphrase is a lost backup.
- `./backups` is in `.gitignore` and `.dockerignore`, so dumps are neither
  committed nor sent to an image build. If `BACKUP_DIR` points at another
  folder inside the checkout, add that one to both files.
- The dumps sit on the same disk as the database unless `BACKUP_DIR` points
  somewhere else. Copying them to another machine is up to you.
- A failed or late dump shows on the admin's dashboard (see above).
  `docker compose logs backup` shows every dump and every failure, and a
  failed dump is tried again a minute later.
- `docker compose down -v` removes the database volume, not the dumps.
- The images of image classification and box projects are not in the
  database. A task only holds their URL, so the files stay wherever that
  points.
- With `SEED_DEMO` left on, the app adds the demo organisation on start when
  the restored data does not have it.
- `docker-compose.dev.yml` is only a database for local development and has
  no backup service.

## Tests and checks

```bash
npm test                 # unit + integration (needs TEST_DATABASE_URL)
npm run test:unit        # domain logic only, no database
npm run test:dom         # components and pages in jsdom, with axe
npm run check            # lint, format, typecheck and tests, like CI
npm run build
```

Integration tests call route loaders and actions directly with real `Request`
objects and a signed session cookie, against a real PostgreSQL database.

DOM tests render the labeling interfaces and the main pages in jsdom (pages
through `createRoutesStub`, inside the real app layout) and fail on any axe
violation. Colour contrast is checked from the stylesheet in a unit test,
since jsdom has no colours.

CI also proves that a backup restores: it puts the demo data into the test
database, dumps it with `docker/backup.sh`, restores the dump into a scratch
database and compares the row count of every table
(`docker/check-backup.sh`). The same script runs the daily loop and the
pruning against made-up clocks first (`docker/check-backup-loop.sh`).

## Project layout

```
app/
  domain/        schemas, answer validation, consensus, kappa, gold scoring,
                 payouts, CSV/JSONL import, JSONL/CSV/COCO export
  models/        *.server.ts data access (queue, reviews, quality, payouts, ...)
  lib/           sessions, auth, permissions, formatting, pagination
  components/    UI pieces and the labeling interfaces
  routes/        pages and resource routes (see docs/routes.md)
prisma/          schema, migrations, demo seed
docker/          container entrypoint, backup script and its checks
tests/unit/      domain tests
tests/integration/  loader/action tests against PostgreSQL
tests/dom/       components and pages in jsdom, with axe
docs/            architecture, routes, import/export formats, quality metrics
```

More detail: [architecture](docs/architecture.md),
[routes and permissions](docs/routes.md),
[import and export formats](docs/import-export.md),
[quality metrics](docs/quality.md). What might come next:
[roadmap](ROADMAP.md).

## Troubleshooting

- **Signed out right after signing in on plain http**: production builds use
  secure cookies. Set `COOKIE_SECURE=false` when you serve the app without
  HTTPS (the compose file already does).
- **"SESSION_SECRET must be set"** on start: production refuses the built-in
  development secret. Set `SESSION_SECRET` to 16 or more random characters.
- **Integration tests fail with "database does not exist"**: create the test
  database (`createdb labeling_test`) or use `docker-compose.dev.yml`, which
  creates it on first start, and point `TEST_DATABASE_URL` at it.
- **"Too many attempts" on sign-in**: ten failed attempts lock an email for
  fifteen minutes. Restarting the app clears the counter.
- **A task is stuck as claimed**: claims expire after the project's time limit
  and are released the next time anyone asks for work in that project. An
  admin or project manager can release a claim at once from "Claims" on the
  task page.
- **"Draft not saved" next to the working time**: saving has stopped for this
  task, and what is on the screen can no longer be handed in. Either the claim
  ran out of time (submitting takes you back to the project and the task
  returns to the queue), or the task was already submitted, skipped or released
  in another tab (submitting answers "This task is no longer yours"), or you
  were signed out (the next click leads to the sign-in page). "Draft not saved
  yet" is different: one save did not reach the server and is tried again by
  itself.
- **A submission says another reviewer is on it**: "Start reviewing" reserves
  a submission for 15 minutes and keeps it reserved while that reviewer works
  on it. If they walked away, it frees up by itself 15 minutes later.
- **The demo data did not appear**: the seed only runs when `SEED_DEMO=true`
  and skips itself if the demo organisation already exists. Remove the volume
  with `docker compose down -v` to start over.

## License

MIT, see [LICENSE](LICENSE).
