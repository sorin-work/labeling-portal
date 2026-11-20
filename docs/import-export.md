# Importing tasks and exporting labels

Only admins and project managers can import or export, and the server checks
it on every request. An export holds the rows of one project and nothing from
another project or organisation.

## Task schemas

A project's schema is JSON and decides the labeling interface and which fields
of an imported row it reads.

| `kind`                 | Fields it reads                                   | Other settings                                                      |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `text_classification`  | `textField`                                       | `labels` (2-30), `multiple`                                         |
| `image_classification` | `imageField` (http(s) URL or `/path`)             | `labels` (2-30), `multiple`                                         |
| `ner`                  | `textField`                                       | `entities` (`name`, optional `color`)                               |
| `pairwise`             | `promptField`, `responseAField`, `responseBField` | `dimensions` (rubric, scored 1-5), `allowTie`, `minRationaleLength` |
| `bbox`                 | `imageField` (http(s) URL or `/path`)             | `labels`, `minBoxSize` (pixels)                                     |

## Import files

Every row of a file becomes one task.

| Format     | File                | Notes                                                             |
| ---------- | ------------------- | ----------------------------------------------------------------- |
| CSV        | `.csv`              | Header row. Comma or semicolon, told apart by the header line     |
| TSV        | `.tsv`, `.tab`      | Header row, tab between fields                                    |
| JSON Lines | `.jsonl`, `.ndjson` | One JSON object per line                                          |
| JSON       | `.json`             | One array of objects. A `.json` file of JSON Lines is read as one |

- `id` or `_id` is kept as the task's external id and must be unique per file.
- `_gold` marks a gold task and holds its answer (see below).
- Any other columns are stored with the task and shown to annotators as context.
- Fields starting with `_` are importer instructions and are not stored.
- Tick "qualification test" to import the rows as test questions instead of
  work. Every row then needs a `_gold` answer.
- In CSV and TSV a field can be wrapped in double quotes and then hold the
  delimiter, line breaks and `""` for a quote. A quote in the middle of a
  field is an ordinary character.
- The file has to be UTF-8. A byte order mark and Windows line endings are fine.

### All or nothing

A file is imported completely or not at all. One row with a problem refuses
the file, and nothing of it is stored. The refusal lists the first 20
problems with their line (or, for a JSON array, their item) and says how many
more there are.

### Limits

- 5 MB per file. The upload is cut off once it is larger; it is not read to
  the end first.
- 5,000 rows per file.
- Zip and gzip files are refused and never unpacked, which includes `.xlsx`
  spreadsheets. A small archive can unpack to gigabytes, and no import format
  needs one.
- A row may nest at most 32 levels deep and hold at most 10,000 values (keys
  and array items at every level), checked right after each line or item is
  parsed. In a re-imported CSV export the `data` and `answer` columns are
  checked the same way.
- In CSV and TSV files, a quoted field that is still open at the end of the
  file refuses the file, naming the line where the quote opened. Such a field
  would otherwise take in every line after it.

### Imported text is data

Nothing from an import is ever shown as HTML. Text, context columns and
labels are stored as they were written and shown as plain text. Only a
project's instructions, which a manager writes, are rendered as Markdown.

For image classification and box projects the image address has to be an absolute `http://` or
`https://` URL, or a path on the portal itself that starts with one `/`.
Anything else is refused: `javascript:`, `data:` and `file:` addresses, and
`//host/...` addresses that borrow the page's scheme. The server never
requests an image, not at import time and not later. The address is stored as
text and only the browser of an annotator loads it. A server that fetched
addresses from an upload could be made to call hosts on its own network.

The browser of every annotator would load the image, though, from inside the
annotator's own network. So addresses that point inside a network are refused
as well: IP literals that are loopback, private, shared, link-local,
documentation, multicast or reserved (`127.0.0.1`, `10.x`, `172.16-31.x`,
`192.168.x`, `169.254.169.254`, `::1`, `fe80::`, `fc00::/7` and so on, in
any spelling the URL parser accepts, such as `0x7f.1`), IPv6 addresses outside
global unicast and the 6to4 and Teredo ranges that carry an IPv4 address, host
names without a dot (`localhost`, `intranet`) and names under `.local`,
`.localhost`, `.internal` and `.home.arpa`. Host names are not looked up, so a
public name that resolves to an internal address is not caught; the server
never resolves or requests them.

An installation that serves images from an internal host on purpose lists it
in `INTERNAL_IMAGE_HOSTS`, comma separated (for example
`images.internal,10.0.0.5`). The list is empty by default, and only the exact host
names and addresses in it are let through. It applies to every project of the
installation.

The address is checked once, when the file is imported. Two things are not
covered by that check:

- A public address that redirects to an internal host is followed by the
  annotator's browser. The portal never requests the address, so it cannot
  see the redirect.
- Removing a host from `INTERNAL_IMAGE_HOSTS` does not touch tasks that were
  already imported with it. They keep their addresses and are still handed
  out; take such a batch out of the queue by pausing it, or remove it.

### Suggested answers (`_prediction`)

A `_prediction` column holds a suggested answer for the task, for example the
output of a model that ran somewhere else. It takes the same short forms and
full answers as `_gold` (below) and is checked against the schema the same
way; a prediction the schema refuses fails the line. A gold row (one with
`_gold`) takes no `_prediction`: gold tasks only show the rule's suggestions. It is stored on the task
apart from every answer and shown to annotators as a suggestion (see
"Suggested answers" in `docs/architecture.md`). A qualification test takes no
`_prediction`. The JSON Lines export writes each task's `suggestion` (its
answer and where it came from) and, for each annotation, `from_suggestion`
and `suggestion_unchanged`.

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

A gold answer goes through the same checks as an annotator's answer, against
the project's schema as it is when the file is imported: a label has to be in
the schema, a span inside the text, a box inside the image, and `tie` is only
a preference where the schema allows ties. Once imported it is stored work.
The schema cannot drop a label that a gold answer uses (see "Changing the
schema once work exists" in [architecture](architecture.md)), and a batch is
refused if the schema changed between reading the file and storing it.

The import page has links to an example CSV and JSONL file for the project.

## Exports

Only accepted work is exported (approved, fixed by a reviewer, or accepted
without review). Gold and qualification tasks are left out. Choose completed
tasks only or every task, and optionally a single batch.

`GET /projects/:id/download?format=&scope=&batch=&annotators=`

| Parameter    | Values                                         | Default     |
| ------------ | ---------------------------------------------- | ----------- |
| `format`     | `jsonl`, `csv`, `coco`, `yolo`, `voc`, `conll` | `jsonl`     |
| `scope`      | `complete`, `all`                              | `complete`  |
| `batch`      | a batch id of the project                      | all batches |
| `annotators` | `pseudonym`, `email`                           | `pseudonym` |

| Format  | Kinds    | File         | What it holds                                        |
| ------- | -------- | ------------ | ---------------------------------------------------- |
| `jsonl` | all      | `.jsonl`     | One task per line with every accepted annotation     |
| `csv`   | all      | `.csv`       | One row per accepted annotation, plus consensus rows |
| `coco`  | boxes    | `.coco.json` | COCO object detection dataset                        |
| `yolo`  | boxes    | `.yolo.zip`  | One label file per image, `classes.txt`, a manifest  |
| `voc`   | boxes    | `.voc.zip`   | One Pascal VOC XML file per image, a manifest        |
| `conll` | entities | `.conll`     | One token and its BIO tag per line                   |

The names below are fixed. Files that people keep stay readable: a field or
column is not renamed or removed, and new ones are added at the end.

- Text files are UTF-8. Dates are ISO 8601 in UTC, like
  `2026-03-10T09:05:00.000Z`.
- A download is written as a stream, task by task, and reads only the columns
  it uses. Drafts and pay data are never part of a label export.
- **Annotators** are named by a pseudonym, `ann_` and eight hex characters,
  which is the same in every export of the project and differs between
  projects. Exports get passed around. `annotators=email` gives the email
  address instead.
- `coco`, `yolo`, `voc` and `conll` hold one label per task: the consensus, or
  the single accepted answer when there is no consensus. A task with neither
  has no label yet. `conll`, `yolo` and `voc` leave such a task without
  labels, since an empty label file would say that there is nothing to label.

### JSON Lines

One object per task:

| Field              | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| `task_id`          | The task's id in the portal                                  |
| `external_id`      | The `id` from the import, or `null`                          |
| `batch`            | Name of the batch                                            |
| `status`           | `open`, `adjudication` or `complete`                         |
| `data`             | The imported row                                             |
| `consensus`        | The merged answer, or `null`                                 |
| `agreement`        | 0 to 1, or `null`                                            |
| `annotations`      | List of accepted annotations, oldest first (see below)       |
| `consensus_source` | `majority`, `adjudicated` (settled by a reviewer), or `null` |

Each annotation has `annotator`, `answer`, `review_status` (`approved`,
`fixed` or `not_required`), `qa_score` (1 to 5 or `null`), `active_seconds`
and `submitted_at`. An answer has the shape of a gold answer above; entity
spans also carry the covered `text`, and a pairwise answer has `scores` and
`rationale`.

### CSV

One row per accepted annotation, then one row with `consensus` as the
annotator for a task that has a consensus. Columns, in this order:

`task_id`, `external_id`, `batch`, `annotator`, `review_status`, `qa_score`,
`active_seconds`, the answer columns, `submitted_at`, `answer`, `data`,
`task_status` (`open`, `adjudication` or `complete`).

| Kind           | Answer columns                                                            |
| -------------- | ------------------------------------------------------------------------- |
| Classification | `labels` (joined with `\|`)                                               |
| Entities       | `entities` (`TYPE:text; TYPE:text`)                                       |
| Pairwise       | `preference`, `a_<dimension>` and `b_<dimension>` per rubric, `rationale` |
| Boxes          | `boxes` (JSON list)                                                       |

`answer` holds the whole answer as JSON and `data` the imported row as JSON.
A task without accepted work has no row. A task waiting for adjudication has
no consensus, in this or any other format, until a reviewer settles it.

A cell that starts with `=`, `+`, `-` or `@` gets a single quote in front, so
a spreadsheet program shows it as text instead of running it as a formula.
Numbers are written as they are. The payout and quality CSV files are guarded
the same way.

### COCO

`info`, `categories` (in schema order, ids from 1), `images` (`id`,
`file_name` with the image address, `width`, `height`, `task_id`) and
`annotations` (`bbox` as `[x, y, width, height]` in pixels, `area`,
`category_id`, `image_id`).

### YOLO

A zip with:

- `classes.txt`: the labels in schema order, one per line. The line number,
  from 0, is the class index.
- `labels/<name>.txt`: one line per box, `class cx cy w h`, where the centre
  and the size are shares of the image width and height.
- `manifest.csv`: `file`, `task_id`, `external_id`, `image`, `width`,
  `height`, `boxes` for every exported task. `file` is empty for a task
  without a label.

The images are not in the zip. The portal only knows their addresses.

### Pascal VOC

The same zip with `annotations/<name>.xml` in place of the label files:
`filename`, `path` (the image address), `size` and one `object` with `name`
and `bndbox` (`xmin`, `ymin`, `xmax`, `ymax`) per box. Corners are whole
pixels counted from 0 at the top left.

### File names in a zip

`<name>` is the file name of the image without its extension, or else the
external id, or else the task id. Only letters, digits, `.`, `-` and `_` are
kept, so a name never holds a folder or `..`. When two tasks get the same
name the second becomes `<name>-2`. A zip holds at most 65,533 tasks; export
a larger project one batch at a time.

### CoNLL

One token and its tag per line, separated by a space, and an empty line after
each task:

```
Ada B-PERSON
Lovelace I-PERSON
met O
```

Tags are BIO: `B-TYPE` on the first token of an entity, `I-TYPE` on the rest
of it, `O` elsewhere. A word (letters, digits, an apostrophe inside it) is a
token and so is every other character that is not white space. White space in
an entity type becomes `_`.

Spans are character offsets and need not end where a token ends: an
annotator can select half a word. Every token a span touches gets its tag,
which widens such a span to whole tokens. The export page counts the spans
that do not line up when asked ("Count the spans that do not line up").

## Importing an export again

The JSON Lines and the CSV export can be imported, into the same project or
another one with a matching schema. Each task comes back with its `data` and
its external id, in the same order. Its consensus becomes the gold answer of
the new task, after the same checks any gold answer gets, so tasks with a
consensus come back as gold tasks (or as test questions, with "qualification
test" ticked) and the others as ordinary tasks.

- A file is taken for an export by its shape: a JSON object with `task_id`,
  `data`, `consensus` and `annotations`, or a CSV file with the columns
  `task_id`, `annotator`, `answer` and `data`. Anything else is read as
  ordinary rows.
- The annotations of the single annotators are not imported. They belong to
  people and reviews in the project they came from.
- A gold answer for a pairwise task is the preference. The rubric scores of a
  consensus are not part of it.
- A multi-label consensus without any label is not an answer, so that task
  comes back without one.
- The CSV export has no row for a task without accepted work, so such tasks
  are only in the JSON Lines file.
