# Changelog

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
