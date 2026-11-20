# JSON API

A small API for scripts: list projects, push a batch of tasks, fetch the
labels and look a task up. It lives under `/api/v1/` and answers JSON. Pages
and the API are kept apart: the API takes a token and never the session
cookie, and pages take the cookie and never a token.

## Tokens

Make a token on **Your account** (`/account`). Give it a name, say whether it
may write (import batches) and when it expires (30, 90 or 365 days, or
never). The token is shown once, right after it is made. The portal keeps
only its SHA-256 and its first characters (`lp_` and eight more), which the
list shows so you can tell tokens apart. Revoke a token there when it is no
longer needed or may have leaked. Making and revoking a token is recorded in
the audit trail, without the token.

A token acts as you, with the role you have in the organisation at the time
of each request, and sees what you see on the pages: the same checks decide.
When you leave the organisation, your tokens stop working.

Send it in the `Authorization` header:

```
curl -H "Authorization: Bearer $LP_TOKEN" https://labels.example.test/api/v1/projects
```

- A read-only token can call every `GET` route and nothing else.
- Each token may make 120 requests a minute (per app process). More answer
  429 with `Retry-After`.
- The list on the account page says when a token was last used, to the
  minute.

## Errors

Errors are JSON, `{ "error": "..." }`, never a redirect or a page:

| Status | When                                                                     |
| ------ | ------------------------------------------------------------------------ |
| 400    | A parameter is missing or wrong, or the file has problems (see below)    |
| 401    | No token, or one that is unknown, revoked or expired, or a cookie only   |
| 403    | A read-only token on a write, or your role may not do this               |
| 404    | No such project in your organisation (another organisation's is 404 too) |
| 405    | The wrong method: reads are `GET`, the upload is `POST`                  |
| 409    | The project's schema changed while the file was read; send it again      |
| 413    | The file is larger than 5 MB                                             |
| 422    | The `Idempotency-Key` was used for another file                          |
| 429    | Too many requests with this token                                        |

## Routes

### `GET /api/v1/projects`

The projects you can see, as on the projects page: `id`, `name`,
`description`, `kind`, `status`, `overlap`, `createdAt`.

### `GET /api/v1/projects/:id`

One project with its `schema`, and `progress` with the numbers of its
overview: `tasks`, `complete`, `adjudication`, `gold`, `pendingReview`,
`activeClaims`, `skipped`.

### `POST /api/v1/projects/:id/batches`

Imports a file as a new batch. Needs a token that may write and the project
manager or admin role. The body is the file itself, in any format the import
page takes ([import-export](import-export.md)), with the same limits (5 MB,
5,000 rows) and the same rule: the whole file or nothing.

- `?name=` names the batch. `?filename=` helps tell the format, like the name
  of an uploaded file; otherwise `Content-Type` does (`text/csv`,
  `text/tab-separated-values`, `application/x-ndjson`, `application/json`).
- `?qualification=1` imports qualification questions.
- `Idempotency-Key: <1 to 200 characters>`: send the same upload again with
  the same key and you get the batch the first one made, with
  `"repeated": true`, and nothing is imported twice. The key belongs to the
  project, for good, and is kept with the SHA-256 of the body: a different
  file with a used key answers 422 and imports nothing. Use a new key for a
  new file.

```
curl -X POST \
  -H "Authorization: Bearer $LP_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  -H "Idempotency-Key: tasks-2026-03-01" \
  --data-binary @tasks.jsonl \
  "https://labels.example.test/api/v1/projects/$PROJECT/batches?name=March%201"
```

201 with `{ "batch": { "id", "name", "format", "tasks", "createdAt" },
"repeated": false }`, or 200 with `"repeated": true`. A file with problems
answers 400 with `errors` (the first 20 as `{ line, message }`), `more` (how
many beyond those), `unit` (`line`, or `item` for a JSON array) and
`validRows`.

### `GET /api/v1/projects/:id/export`

The same file as the download on the export page, with the same parameters:
`format` (`jsonl`, `csv`, `coco`, `conll`, `yolo`, `voc`), `scope`
(`complete` or `all`), `batch` and `annotators=email`. Managers and admins.
Every download is recorded in the audit trail; a `HEAD` request gets the
headers only and is not recorded.

```
curl -H "Authorization: Bearer $LP_TOKEN" -o labels.jsonl \
  "https://labels.example.test/api/v1/projects/$PROJECT/export?format=jsonl"
```

### `GET /api/v1/projects/:id/tasks?externalId=`

The tasks with that external id (ids are unique within one file, so there
can be more than one): `id`, `externalId`, `position`, `status`, `consensus`,
`agreement`, `completedAt`, `batchId`. Managers and reviewers, as on the task
page. 404 when there is none.

## Not here yet

Webhooks (a call when a batch completes) and scopes beyond read-only.
