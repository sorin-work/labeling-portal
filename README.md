# labeling-portal

A work portal for data-labeling teams: projects with instructions and a task
schema, a claim-based task queue, review, quality numbers and payouts.

## Quick start with Docker

```bash
docker compose up --build
```

Open http://localhost:4421 and sign in with one of the demo accounts (password
`labeling-demo` for all of them):

| Email                   | Role            |
| ----------------------- | --------------- |
| `admin@example.com`     | Admin           |
| `pm@example.com`        | Project manager |
| `reviewer@example.com`  | Reviewer        |
| `annotator@example.com` | Annotator       |

## Local development

You need Node 22 and PostgreSQL.

```bash
cp .env.example .env    # then point DATABASE_URL at your database
npm install
npm run db:deploy
npm run db:seed
npm run dev             # http://localhost:4421
```

## Tests

```bash
TEST_DATABASE_URL=postgresql://labeling:labeling@localhost:5432/labeling_test npm test
```

Unit tests cover the domain logic; integration tests run loaders and actions
against a real PostgreSQL database.
