# Routes and permissions

All pages are server-rendered React Router routes. Pages that change data post
a form back to the same URL (the route's `action`). Scripts use the JSON API
under `/api/v1/` with a token instead, described in [api](api.md); pages take
no token and the API takes no cookie. The draft autosave of the labeling
pages, described at the end, is the other route that answers JSON. The table
lists who can open each page.

| Path                                | What                                     | Who                                         |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------- |
| `/login`, `/logout`                 | Sign in and out                          | everyone                                    |
| `/`                                 | Dashboard: your projects, stats, claims  | signed in                                   |
| `/projects`                         | Project list                             | signed in (members only see their projects) |
| `/projects/new`                     | Create a project                         | admin, project manager                      |
| `/projects/:id`                     | Overview, instructions, start labeling   | project members, managers                   |
| `/projects/:id/qualification`       | Qualification test                       | annotators on the project                   |
| `/projects/:id/work` (POST)         | Claim the next task                      | annotators, admins                          |
| `/work/:assignmentId`               | Label a claimed task, skip or release it | the annotator who claimed it                |
| `/projects/:id/review`              | Review queue, who holds each submission  | reviewers, managers                         |
| `/projects/:id/review` (POST)       | Reserve the next submission and open it  | reviewers, managers                         |
| `/review/:assignmentId`             | Reserve, then approve, send back or fix  | reviewers, managers (not on their own work) |
| `/projects/:id/disputes`            | Disputes on review decisions             | reviewers, managers                         |
| `/projects/:id/disputes/:disputeId` | Uphold or overturn a disputed decision   | reviewers, managers (not who decided it)    |
| `/projects/:id/adjudication`        | Tasks whose answers agreed too little    | reviewers, managers                         |
| `/projects/:id/quality`             | Annotator stats, kappa, gold accuracy    | reviewers, managers                         |
| `/projects/:id/batches[/new\|/:id]` | Import, browse, gold, priority and pause | admin, project manager                      |
| `/projects/:id/tasks/:taskId`       | Submissions, consensus, adjudication     | reviewers, managers                         |
| `/projects/:id/members`             | Add people, reset qualification          | admin, project manager                      |
| `/projects/:id/export`              | Download labels                          | admin, project manager                      |
| `/projects/:id/activity`            | What managers changed                    | admin, project manager                      |
| `/projects/:id/settings`            | Edit, launch, pause, archive, duplicate  | admin, project manager                      |
| `/my-work`                          | Your submissions, feedback, corrections  | annotators                                  |
| `/my-work/:assignmentId`            | Revise or dispute work, see a gold check | the annotator who did the work              |
| `/earnings`                         | Your own pay for a date range            | signed in (the menu shows it to annotators) |
| `/payouts`                          | Pay report for a date range              | admin, project manager                      |
| `/people`                           | Organisation members, roles, passwords   | admin                                       |
| `/audit`                            | The organisation's audit trail           | admin                                       |
| `/account`                          | Change your password, API tokens         | signed in                                   |

Saving the settings form answers 400 with `errors.schema` when the schema
edit would break stored work, and saves nothing from that post. The rules are
in [architecture](architecture.md#changing-the-schema-once-work-exists).

`/audit` takes `person`, `action`, `project`, `from`, `to` (days in UTC,
both included; no dates means all of them) and `page`. Every read names the
admin's own organisation, so a filter with another organisation's id finds
nothing. `/projects/:id/activity` shows one project's entries in pages to the
managers of the project.

`/earnings` takes no person from the request. Whose earnings it shows comes
from the session, so nobody can open someone else's.

The task page also takes what a manager does to a gold task as POSTs: change
the expected answer, rescore, retire or bring back, and use a completed task
as gold. Only admins and project managers may send them. Reviewers see on that
page that a task is gold and how each answer scored, not the expected answer.
Admins and project managers can also release a claim listed under "Claims"
(`intent=release-claim` with the `assignmentId`). The confirmation says how
long the claim has run, whether a draft is lost and whether its time is paid.
The annotator's open page then answers "This task is no longer yours" on
submit, and its draft saves get 409 `not_active`.
The search on the batch page also finds a task by the reference an annotator
quotes from the work page.

## Downloads and probes

These are resource routes that return files or JSON instead of pages.

| Path                                                           | Returns                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /healthz`                                                 | `{"status":"ok","database":"ok"}` or 503                                 |
| `GET /projects/:id/download?format=&scope=&batch=&annotators=` | Label export as a stream: `jsonl`, `csv`, `coco`, `yolo`, `voc`, `conll` |
| `GET /projects/:id/example?format=csv\|jsonl`                  | Example import file for the project's schema                             |
| `GET /projects/:id/quality.csv`                                | Annotator quality table                                                  |
| `GET /payouts/export?from=&to=`                                | Payout CSV, one row per person, project, rate                            |
| `GET /audit/export?person=&action=&project=&from=&to=`         | Audit CSV with the filters of `/audit`, oldest first (admins)            |

Projects from another organisation answer 404, not 403, so their ids cannot
be probed.

## Draft autosave

The work page and the revise page save the answer in progress with `fetch`
while someone is working. These two routes only take a POST and answer with
JSON. Only the annotator the assignment belongs to can use them.

| Path                                | Saves                                         | Allowed while                         |
| ----------------------------------- | --------------------------------------------- | ------------------------------------- |
| `POST /work/:assignmentId/draft`    | The draft and the working time of a claim     | the claim is active and not timed out |
| `POST /my-work/:assignmentId/draft` | The changes in progress to a sent-back answer | the submission is sent back           |

Form fields: `draft`, a JSON object of at most 200 KB, and for a claim
`activeSeconds`. A claim can be saved without `draft`: the stored draft then
stays as it is and only the working time is updated. The draft is not checked
against the task schema, because an unfinished answer is not a valid one yet.

| Status | Body                                           | When                                     |
| ------ | ---------------------------------------------- | ---------------------------------------- |
| 200    | `{"ok":true}` (a claim adds `draftSeconds`)    | saved                                    |
| 400    | `{"ok":false,"error":"malformed"}`             | `draft` is not a JSON object             |
| 413    | `{"ok":false,"error":"too_large"}`             | `draft` is over 200 KB                   |
| 404    | `{"ok":false,"error":"not_found"}`             | no such assignment, or not yours         |
| 409    | `{"ok":false,"error":"not_active"}`, `expired` | submitted, skipped, released or too late |
| 403    | `{"ok":false,"error":"cross_origin"}`          | the request came from another site       |

Without a session the answer is the usual redirect to the sign-in page. The
`Origin` header (or `Referer` without it) has to be this app's own origin, the
same rule React Router applies to page actions.
