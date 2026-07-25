# Routes and permissions

All pages are server-rendered React Router routes. Pages that change data post
a form back to the same URL (the route's `action`); there is no separate JSON
API. The table lists who can open each page.

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
| `/projects/:id/review`              | Review queue                             | reviewers, managers                         |
| `/review/:assignmentId`             | Approve, send back or fix a submission   | reviewers, managers (not on their own work) |
| `/projects/:id/quality`             | Annotator stats, kappa, gold accuracy    | reviewers, managers                         |
| `/projects/:id/batches[/new\|/:id]` | Import and browse tasks                  | admin, project manager                      |
| `/projects/:id/tasks/:taskId`       | Every submission and the consensus       | reviewers, managers                         |
| `/projects/:id/members`             | Add people, reset qualification          | admin, project manager                      |
| `/projects/:id/export`              | Download labels                          | admin, project manager                      |
| `/projects/:id/activity`            | What managers changed                    | admin, project manager                      |
| `/projects/:id/settings`            | Edit, launch, pause, archive, duplicate  | admin, project manager                      |
| `/my-work`                          | Your submissions, feedback, corrections  | annotators                                  |
| `/payouts`                          | Pay report for a date range              | admin, project manager                      |
| `/people`                           | Organisation members, roles, passwords   | admin                                       |
| `/account`                          | Change your password                     | signed in                                   |

## Downloads and probes

These are resource routes that return files or JSON instead of pages.

| Path                                               | Returns                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `GET /healthz`                                     | `{"status":"ok","database":"ok"}` or 503       |
| `GET /projects/:id/download?format=&scope=&batch=` | `jsonl`, `csv` or `coco` (box projects) export |
| `GET /projects/:id/example?format=csv\|jsonl`      | Example import file for the project's schema   |
| `GET /projects/:id/quality.csv`                    | Annotator quality table                        |
| `GET /payouts/export?from=&to=`                    | Payout CSV (dates inclusive, UTC)              |

Projects from another organisation answer 404, not 403, so their ids cannot
be probed.
