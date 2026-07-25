# Importing tasks and exporting labels

## Task schemas

A project's schema is JSON and decides the labeling interface and which fields
of an imported row it reads.

| `kind`                | Fields it reads                                   | Other settings                                                      |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `text_classification` | `textField`                                       | `labels` (2-30), `multiple`                                         |
| `ner`                 | `textField`                                       | `entities` (`name`, optional `color`)                               |
| `pairwise`            | `promptField`, `responseAField`, `responseBField` | `dimensions` (rubric, scored 1-5), `allowTie`, `minRationaleLength` |
| `bbox`                | `imageField` (http(s) URL or `/path`)             | `labels`, `minBoxSize` (pixels)                                     |

## Import files

Upload CSV (with a header row) or JSON Lines. Every row becomes one task.

- `id` or `_id` is kept as the task's external id and must be unique per file.
- `_gold` marks a gold task and holds its answer (see below).
- Any other columns are stored with the task and shown to annotators as context.
- Fields starting with `_` are importer instructions and are not stored.
- Up to 5,000 rows and 5 MB per file. Rows with problems are listed with their
  line numbers; tick "skip invalid rows" to import the rest.
- Tick "qualification test" to import the rows as test questions instead of
  work. Every row then needs a `_gold` answer.

### Gold answers

| Kind           | Short form in CSV    | Full form (JSON)                                                    |
| -------------- | -------------------- | ------------------------------------------------------------------- |
| Classification | `positive` or `a\|b` | `{"labels": ["positive"]}`                                          |
| Entities       |                      | `{"spans": [{"start": 0, "end": 3, "label": "PERSON"}]}`            |
| Pairwise       | `A`, `B` or `tie`    | `{"preference": "A"}`                                               |
| Boxes          |                      | `{"boxes": [{"x": 10, "y": 20, "w": 50, "h": 40, "label": "car"}]}` |

Span offsets count UTF-16 code units, like JavaScript strings. For boxes the
image size is taken from `width`/`height` columns when the gold answer does not
include `imageWidth`/`imageHeight`.

The import page has links to an example CSV and JSONL file for the project.

## Exports

Only accepted work is exported (approved, fixed by a reviewer, or accepted
without review). Gold and qualification tasks are left out. Choose completed
tasks only or every task, and optionally a single batch.

- **JSONL**: one task per line with `data`, `consensus`, `agreement` and every
  accepted annotation (annotator email, final answer, review status, QA score,
  active seconds). Entity spans include the covered `text`.
- **CSV**: one row per annotation plus a `consensus` row per completed task.
  Pairwise answers are flattened to `preference`, `a_<dimension>`,
  `b_<dimension>` and `rationale` columns.
- **COCO** (box projects): images, categories (in schema order) and the
  consensus boxes as `[x, y, width, height]` in pixels.
