# labeling-portal

A work portal for data-labeling teams. Project managers set up projects with
instructions and a task schema, import tasks, and watch quality and pay;
annotators claim tasks from a queue and label them; reviewers approve, send back
or fix the work.

- **Organisations and roles**: admin, project manager, reviewer and annotator,
  with every project scoped to its organisation
- **Projects**: Markdown instructions with live preview, a JSON task schema,
  annotators per task (overlap), time limit, review on/off, pay rate
- **Four labeling interfaces**: text classification (single or multi-label),
  named-entity span highlighting, pairwise response comparison with a rubric
  (A vs B preference, 1-5 scores per dimension for both sides, written
  rationale) and bounding boxes on images, all with keyboard shortcuts
- **Import** CSV or JSONL into batches with per-line error reports, example
  files and gold answers in a `_gold` column
- **Task queue**: claim the next task, time limits with automatic release of
  abandoned claims, one extension per claim, skip with a reason, release
- **Review**: approve, send back with feedback, or fix the answer; QA scores
  1-5; annotators revise sent-back work and see corrections
- **Quality**: per-annotator approval rate, QA score, gold accuracy, speed and
  throughput; Cohen's and Fleiss' kappa; consensus answers per task
- **Gold tasks** scored automatically and a **qualification test** before an
  annotator may work on a project
- **Time tracking** of active time per task and a **payouts** report (per task
  or hourly) with CSV download
- **Export** of finished labels as JSONL, CSV or COCO (box projects)
- Activity log, needs-attention list for managers, demo data

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
organisation, _Harbor Data Labs_, is created with four projects (one per
labeling kind), a few weeks of reviewed work, gold tasks and a qualification
test. Every demo account uses the password `labeling-demo`:

| Email                    | Role            | Try                                                               |
| ------------------------ | --------------- | ----------------------------------------------------------------- |
| `admin@example.com`      | Admin           | People, payouts, everything below                                 |
| `pm@example.com`         | Project manager | Import a batch, quality, payouts, export                          |
| `reviewer@example.com`   | Reviewer        | Review queue of _Product review sentiment_                        |
| `annotator@example.com`  | Annotator       | Label tasks; take the qualification test for the pairwise project |
| `annotator2@example.com` | Annotator       | Qualified for the pairwise project, has returned work             |
| `annotator3@example.com` | Annotator       | Lower gold accuracy, shows up in "needs attention"                |

Change the port with `WEB_PORT=8080 docker compose up`. Data lives in the
`db-data` volume; `docker compose down -v` starts fresh.

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

| Variable            | Default               | Purpose                                                           |
| ------------------- | --------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`      | (required)            | PostgreSQL connection string                                      |
| `SESSION_SECRET`    | dev-only value        | Signs the session cookie; required (16+ characters) in production |
| `COOKIE_SECURE`     | `true` in production  | Set `false` when serving over plain http                          |
| `SEED_DEMO`         | `false`               | Docker only: create the demo organisation on start                |
| `SHOW_DEMO_LOGINS`  | `false`               | List the demo accounts on the sign-in page                        |
| `TEST_DATABASE_URL` | local `labeling_test` | Database for integration tests (it is truncated between tests)    |
| `WEB_PORT`          | `4421`                | Host port for the compose setup                                   |

## Tests and checks

```bash
npm test                 # unit + integration (needs TEST_DATABASE_URL)
npm run test:unit        # domain logic only, no database
npm run check            # lint, format, typecheck and tests, like CI
npm run build
```

Integration tests call route loaders and actions directly with real `Request`
objects and a signed session cookie, against a real PostgreSQL database.

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
tests/unit/      domain tests
tests/integration/  loader/action tests against PostgreSQL
docs/            architecture, routes, import/export formats, quality metrics
```

More detail: [architecture](docs/architecture.md),
[routes and permissions](docs/routes.md),
[import and export formats](docs/import-export.md),
[quality metrics](docs/quality.md).

## License

MIT, see [LICENSE](LICENSE).
