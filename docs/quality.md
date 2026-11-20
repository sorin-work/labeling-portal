# Quality metrics

The quality tab of a project (reviewers, project managers, admins) shows how
well people label and how much they agree. This page explains each number.

## Per annotator

| Column       | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| Submitted    | Tasks submitted, gold tasks included                                          |
| Skipped      | Tasks skipped, with the reasons summarised under the table                    |
| Reviewed     | Share of their submissions a reviewer has decided on, gold tasks not counted  |
| Approval     | Approve decisions divided by all review decisions on their work               |
| Sent back    | How often a reviewer returned their work with feedback                        |
| QA score     | Average 1-5 quality score reviewers gave                                      |
| Gold         | Average score on gold tasks (see below); flagged ⚑ below 80% after 3 attempts |
| Avg time     | Average active time per submission                                            |
| Tasks / hour | Submissions divided by total active time                                      |

Approval, sent back and QA score only describe the reviewed part of someone's
work. With review sampling (below) or a backlog in the review queue that can
be a small part, which is what the Reviewed column is for.

Click a name for that person's recent work in the project. The table can be
sorted by any column and downloaded as CSV.

## Review sampling

A project with review on reviews every submission unless "Share to review"
in its settings is below 100. Then, for each new submission:

1. Until ten of the annotator's submissions in the project have gone to
   review, it is reviewed. Nobody's first work goes unseen.
2. If the annotator is flagged ⚑ in the table above, it is reviewed.
3. Otherwise chance decides, with the configured share as the probability.

A share of 0 keeps only the first two rules. The outcome is decided once, at
submission, and never changes: the review page says why a submission is in
the queue, and the task page marks work that was accepted without review.
Work that is not picked counts as accepted straight away, completes its task
like approved work and is paid the same. Sent-back work always comes back to
a reviewer. Gold tasks are scored instead of reviewed, with or without
sampling.

## Gold scores

Gold tasks have a known answer and are mixed into the queue. Each submission is
scored from 0 to 1:

- **Classification**: 1 for the same labels; otherwise the overlap of the two
  label sets (Jaccard).
- **Entities**: F1 over spans that match exactly (start, end and type).
- **Pairwise**: 1 for the same preference, 0.5 when one side is a tie, else 0.
- **Boxes**: F1 over boxes matched one to one with the same label and an
  intersection over union of at least 0.5.

The qualification test uses the same scores; the attempt passes when the
average, in percent, reaches the project's pass mark.

## Agreement

For classification and pairwise projects the answers are categories, so the
page shows:

- **Cohen's kappa** for each pair of annotators with at least three tasks in
  common. 1 is perfect agreement, 0 is what chance would give.
- **Fleiss' kappa** across all tasks with two or more answers.

They are described with the usual Landis and Koch bands (slight, fair,
moderate, substantial, almost perfect).

Entity and box projects use F1 between annotators instead; the page shows the
mean agreement of completed tasks.

## Consensus

When a task has as many accepted answers as the project's overlap, they are
merged:

- Classification and pairwise: majority vote (no answer on a tie); rubric
  scores are averaged, for the dimensions the rubric has now and over the
  answers that have a score for them.
- Entities: spans marked by a majority of annotators.
- Boxes: boxes clustered by label and overlap; clusters drawn by a majority are
  averaged.
