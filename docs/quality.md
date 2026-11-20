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

A decision that a dispute overturned counts for nobody: it is left out of
Reviewed, Approval, Sent back and QA score, and out of the reviewer's own
numbers on their dashboard, which show it as "Overturned" instead.

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

## Managing gold tasks

Gold answers are sometimes wrong, and a wrong one marks good annotators down.
On the page of a gold task a manager (admin or project manager) can:

- **Change the expected answer**, with a reason. The answer is checked like an
  imported gold answer against the project's schema as it is now. The old
  answer, who changed it, when and why stay in the task's history. Scores
  that were already given are not touched by the edit.
- **Rescore.** Once the expected answer differs from what some stored answers
  were scored against, the page says how many scores would change, whose gold
  accuracy moves and who would become flagged or stop being flagged. Nothing
  happens until the manager presses "Rescore". It recomputes from the stored
  answers in one transaction, so doing it twice gives the same scores as doing
  it once, and nobody is asked to label anything again.
- **Retire** the task, with a reason: it is no longer handed out and its
  scores count for nobody. They are kept, so "Bring back" restores them. The
  page says beforehand whose accuracy moves.
- **Use a completed task as gold**, from its page or for several ticked tasks
  on the batch page. The task is copied with its consensus as the expected
  answer (if that is still a valid answer for today's schema). The original
  and its labels stay as they are and stay in the export; gold tasks never
  are. The copy lands at the position of a random open task, in the batch of
  its original, and is never handed to the people who labeled the original.

What follows the scores, and what does not:

- Gold accuracy, the ⚑ flag, the "needs attention" list and the rule that
  everything from a flagged annotator is reviewed all read the current
  scores, so they follow a rescore or a retirement at once.
- **Pay does not.** A rescore or a retirement only changes gold scores. Gold
  work that was accepted stays accepted and paid, whatever the new score.
- **Qualification does not.** A qualification question's expected answer can
  be changed the same way, but past attempts are not regraded: score, outcome
  and "qualified" are stored results. New attempts are graded against the
  new answer. To let someone try again, reset their qualification on the
  Members tab.

The quality page lists the gold tasks with the lowest average score (at least
two answers). A gold task that most people miss is usually the one that is
wrong.

### What annotators see

While working, nothing tells an annotator that a task is gold: the work page
gets the same fields for every task, without the task's own id or anything
about gold, a copied gold task sits in an ordinary batch at an ordinary
position, and people who would recognise it from the original never get it.
The server does slightly different work for a gold submission than for a
regular one (no review sample, no task to complete), which is not hidden.

After submitting, an annotator sees their score next to the submission on "My
work" and can compare their answer with the expected one, unless the project
turns "gold feedback" off in its settings. With it off they get neither, and
that project's gold tasks also stay out of the gold accuracy on their own
dashboard, which would otherwise move right after a gold task. Retired gold
tasks are never shown as gold.

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
  scores are averaged, for the dimensions the rubric has now.
- Entities: spans marked by a majority of annotators.
- Boxes: boxes clustered by label and overlap; clusters drawn by a majority are
  averaged.
