import { beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { runDueJobs } from '~/models/jobs.server';
import { isPrelabelRunning, prelabelJob, runPrelabel } from '~/models/prelabel.server';
import { claimNextTask } from '~/models/queue.server';
import { action as batchAction } from '~/routes/batch-detail';
import { action as importAction } from '~/routes/batch-new';
import { loader as downloadLoader } from '~/routes/project-download';
import { loader as qualityLoader } from '~/routes/project-quality';
import { action as settingsAction } from '~/routes/project-settings';
import { action as workAction, loader as workLoader } from '~/routes/work';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTestProject,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
} from './helpers';

const sentiment = SCHEMA_TEMPLATES.text_classification;
const rule = { rule: 'keywords', labels: { positive: ['great'], negative: ['broken'] } };

async function world(options: { prelabel?: object; overlap?: number } = {}) {
  const org = await createOrg();
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  const project = await createTestProject(org.id, {
    schema: sentiment,
    reviewRequired: false,
    overlap: options.overlap ?? 1,
  });
  if (options.prelabel) {
    await prisma.project.update({
      where: { id: project.id },
      data: { prelabel: options.prelabel },
    });
  }
  await addToProject(project.id, ann);
  const pmCookie = await cookieFor(pm, org.id);
  const importFile = (text: string, extra: Record<string, string> = {}) =>
    run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie: pmCookie,
        form: {
          file: new File([text], 'tasks.csv', { type: 'text/csv' }),
          name: 'Batch',
          ...extra,
        },
      }),
      { projectId: project.id },
    );
  return { org, pm, ann, project, pmCookie, importFile };
}

const tasks = () => prisma.task.findMany({ orderBy: { position: 'asc' } });

describe('suggestions from the import file', () => {
  beforeEach(resetDb);

  it('reads _prediction like _gold, checks it, and keeps it apart from the data', async () => {
    const { importFile } = await world();
    await importFile('text,_prediction\nGreat phone,positive\nNo idea,\n');
    const [one, two] = await tasks();
    expect(one).toMatchObject({
      data: { text: 'Great phone' },
      suggestion: { labels: ['positive'] },
      suggestionSource: 'file',
    });
    expect(two).toMatchObject({ suggestion: null, suggestionSource: null });
  });

  it('refuses a prediction the schema does not accept', async () => {
    const { importFile } = await world();
    const result = await importFile('text,_prediction\nGreat,happy\n');
    expect(JSON.stringify(payload(result))).toContain('Prediction: ');
    expect(await prisma.task.count()).toBe(0);
  });

  it('takes no prediction on a qualification question', async () => {
    const { importFile } = await world();
    const result = await importFile('text,_gold,_prediction\nGreat,positive,positive\n', {
      qualification: 'on',
    });
    expect(JSON.stringify(payload(result))).toContain(
      'Qualification questions take no _prediction',
    );
  });
});

describe('gold and file predictions', () => {
  beforeEach(resetDb);

  it('refuses a _prediction on a gold row', async () => {
    const { importFile } = await world();
    const result = await importFile('text,_gold,_prediction\nGreat,positive,positive\n');
    expect(JSON.stringify(payload(result))).toContain('A gold row takes no _prediction');
    expect(await prisma.task.count()).toBe(0);
  });

  it('says on the quality page when only file predictions leave gold tasks standing out', async () => {
    const { project, pmCookie, importFile } = await world();
    await importFile('text,_gold,_prediction\nGreat,,positive\nBad,negative,\n');
    const quality = (cookie: string) =>
      run(qualityLoader, makeRequest(`/projects/${project.id}/quality`, { cookie }), {
        projectId: project.id,
      });
    expect(
      payload<{ suggestions: { goldStandsOut: boolean } }>(await quality(pmCookie)).suggestions,
    ).toMatchObject({ goldStandsOut: true });
    await prisma.project.update({ where: { id: project.id }, data: { prelabel: rule } });
    expect(
      payload<{ suggestions: { goldStandsOut: boolean } }>(await quality(pmCookie)).suggestions,
    ).toMatchObject({ goldStandsOut: false });
  });
});

describe('the rule', () => {
  beforeEach(resetDb);

  it('runs after the import, not in it, and suggests for gold tasks as for any other', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile(
      'text,_gold,_prediction\nGreat value,,\nIt came broken,negative,\nMeh,,\nGreat,,negative\n',
    );
    const batch = await prisma.batch.findFirstOrThrow();
    // the request has been answered; the batch says the rule is still to run,
    // and a job that any process can take holds the run
    expect(batch.prelabelState).toBe('PENDING');
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({
      kind: 'prelabel',
      payload: { batchId: batch.id },
      doneAt: null,
    });
    expect(await isPrelabelRunning(batch.id)).toBe(true);
    await runDueJobs();
    expect(await isPrelabelRunning(batch.id)).toBe(false);

    const after = await tasks();
    expect(after.map((t) => [t.suggestion, t.suggestionSource])).toEqual([
      [{ labels: ['positive'] }, 'keywords'],
      // a gold task is not told apart by a missing suggestion
      [{ labels: ['negative'] }, 'keywords'],
      // tried, nothing found: not tried again
      [null, 'keywords'],
      // the file's prediction wins over the rule
      [{ labels: ['negative'] }, 'file'],
    ]);
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'DONE',
      prelabelNote: 'Suggested an answer for 2 of 3 tasks.',
    });
  });

  it('a job that runs twice, or for a batch that is done, changes nothing', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile('text\nGreat\nMeh\n');
    await runDueJobs();
    const batch = await prisma.batch.findFirstOrThrow();
    const before = await tasks();
    await prelabelJob.run(
      { batchId: batch.id },
      { job: { id: 'x', attempts: 2, maxAttempts: 3 }, holds: async () => true },
    );
    expect(await tasks()).toEqual(before);
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'DONE',
      prelabelNote: 'Suggested an answer for 1 of 2 tasks.',
    });
    // a batch that was deleted in the meantime
    await prelabelJob.run(
      { batchId: 'gone' },
      { job: { id: 'y', attempts: 1, maxAttempts: 3 }, holds: async () => true },
    );
  });

  it('a run that no longer holds its job writes no result on the batch', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile('text\nGreat\n');
    const batch = await prisma.batch.findFirstOrThrow();
    await runPrelabel(batch.id, { holds: async () => false });
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'PENDING',
      prelabelNote: null,
    });
  });

  it('marks the batch failed once the job gives up', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile('text\nGreat\n');
    const batch = await prisma.batch.findFirstOrThrow();
    await prelabelJob.giveUp!({ batchId: batch.id }, 'it broke');
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'FAILED',
      prelabelNote: 'The suggestion rule failed.',
    });
  });

  it('never runs over a qualification test', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile('text,_gold\nGreat,positive\n', { qualification: 'on' });
    await runDueJobs();
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({ prelabelState: null });
    expect((await tasks())[0]).toMatchObject({ suggestion: null, suggestionSource: null });
  });

  it('stops at its time limit, and Continue on the batch page goes on without starting over', async () => {
    const { project, pmCookie, importFile } = await world({ prelabel: rule });
    await importFile(`text\n${Array.from({ length: 6 }, (_, i) => `Great ${i}`).join('\n')}\n`);
    await runDueJobs();
    await prisma.task.updateMany({ data: { suggestion: undefined, suggestionSource: null } });
    const batch = await prisma.batch.findFirstOrThrow();
    let t = 0;
    await runPrelabel(batch.id, { timeLimitMs: 3000, clock: () => (t += 1000) });
    const done = await prisma.task.findMany({ where: { suggestionSource: 'keywords' } });
    expect(done).toHaveLength(2);
    const marked = new Map(done.map((d) => [d.id, d.suggestion]));

    await run(
      batchAction,
      makeRequest(`/projects/${project.id}/batches/${batch.id}`, {
        cookie: pmCookie,
        form: { intent: 'prelabel-continue' },
      }),
      { projectId: project.id, batchId: batch.id },
    );
    await runDueJobs();
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'DONE',
      // only the four still to do were run; the first two were not started over
      prelabelNote: 'Suggested an answer for 4 of 4 tasks.',
    });
    for (const [id, suggestion] of marked) {
      expect((await prisma.task.findUniqueOrThrow({ where: { id } })).suggestion).toEqual(
        suggestion,
      );
    }
    expect(await prisma.activity.count({ where: { action: 'batch.prelabel' } })).toBe(0);
  });

  it('leaves a task that someone has been handed, also without a suggestion yet', async () => {
    const { project, importFile, ann } = await world({ prelabel: rule });
    await importFile('text\nGreat\nGreat again\n');
    await runDueJobs();
    await prisma.task.updateMany({ data: { suggestion: undefined, suggestionSource: null } });
    // someone claimed the first task before the rule got to it
    await claimNextTask(project, ann.id);
    await runPrelabel((await prisma.batch.findFirstOrThrow()).id);
    expect((await tasks()).map((t) => t.suggestionSource)).toEqual([null, 'keywords']);
  });

  it('stops at its time limit, and a second run goes on from there', async () => {
    const { importFile } = await world({ prelabel: rule });
    await importFile(`text\n${Array.from({ length: 5 }, (_, i) => `Great ${i}`).join('\n')}\n`);
    await runDueJobs();
    await prisma.task.updateMany({ data: { suggestion: undefined, suggestionSource: null } });
    const batch = await prisma.batch.findFirstOrThrow();

    // a clock that moves a second each time it is read, against a limit of three
    let t = 0;
    const first = await runPrelabel(batch.id, { timeLimitMs: 3000, clock: () => (t += 1000) });
    expect(first).toMatchObject({ state: 'TIMED_OUT', tried: 2 });
    expect(await prisma.batch.findFirstOrThrow()).toMatchObject({
      prelabelState: 'TIMED_OUT',
      prelabelNote: 'Stopped after 2 tasks, at the time limit. Continue to go on from there.',
    });
    const second = await runPrelabel(batch.id);
    expect(second).toEqual({ state: 'DONE', suggested: 3, tried: 3 });
  });

  it('is saved from the settings page, checked against the schema', async () => {
    const { project, pmCookie } = await world();
    const save = (prelabel: string) =>
      run(
        settingsAction,
        makeRequest(`/projects/${project.id}/settings`, {
          cookie: pmCookie,
          form: { intent: 'prelabel', prelabel },
        }),
        { projectId: project.id },
      );
    const refused = payload<{ prelabelErrors: string[] }>(
      await save('{"rule":"keywords","labels":{"happy":["yay"]}}'),
    );
    expect(refused.prelabelErrors).toEqual(['Not in the schema: happy']);
    await save(JSON.stringify(rule));
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).prelabel,
    ).toEqual(rule);
    const entry = await prisma.activity.findFirstOrThrow({ where: { action: 'project.prelabel' } });
    expect(entry.detail).toEqual({ rule: 'keywords', terms: 2 });
    await save('');
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).prelabel,
    ).toBeNull();
  });

  it('runs again from the batch page over tasks nobody has started', async () => {
    const { project, pmCookie, importFile, ann } = await world({ prelabel: rule });
    await importFile('text\nGreat\nbroken\n');
    await runDueJobs();
    // someone has the first task open: its suggestion stays as they saw it
    await claimNextTask(project, ann.id);
    await prisma.project.update({
      where: { id: project.id },
      data: { prelabel: { rule: 'keywords', labels: { neutral: ['great', 'broken'] } } },
    });
    const batch = await prisma.batch.findFirstOrThrow();
    await run(
      batchAction,
      makeRequest(`/projects/${project.id}/batches/${batch.id}`, {
        cookie: pmCookie,
        form: { intent: 'prelabel-restart' },
      }),
      { projectId: project.id, batchId: batch.id },
    );
    await runDueJobs();
    expect((await tasks()).map((t) => t.suggestion)).toEqual([
      { labels: ['positive'] },
      { labels: ['neutral'] },
    ]);
  });
});

describe('a suggestion on the work page and in a submission', () => {
  beforeEach(resetDb);

  async function claimed(prediction = 'positive') {
    const w = await world();
    await w.importFile(`text,_prediction\nGreat phone,${prediction}\nOther,positive\n`);
    const claim = await claimNextTask(w.project, w.ann.id);
    const id = claim.ok ? claim.assignment.id : '';
    const cookie = await cookieFor(w.ann, w.org.id);
    const post = (form: Record<string, string>) =>
      run(workAction, makeRequest(`/work/${id}`, { cookie, form }), { assignmentId: id });
    // taking the suggestion is posted when it happens; the submit form carries
    // no flag of its own (a `fromSuggestion` field there is ignored)
    const submit = async (answer: object, took: boolean) => {
      if (took) await post({ intent: 'take-suggestion' });
      return post({ intent: 'submit', answer: JSON.stringify(answer), fromSuggestion: '1' });
    };
    return { ...w, id, cookie, submit };
  }

  it('is sent with the task, apart from the answer, which starts empty', async () => {
    const { id, cookie } = await claimed();
    const page = payload<{
      suggestion: { answer: object; text: string } | null;
      assignment: { draft: unknown };
    }>(await run(workLoader, makeRequest(`/work/${id}`, { cookie }), { assignmentId: id }));
    expect(page.suggestion).toEqual({
      answer: { labels: ['positive'] },
      text: 'positive',
      taken: false,
    });
    expect(page.assignment.draft).toBeNull();
  });

  it('records a suggestion handed in unchanged', async () => {
    const { id, submit } = await claimed();
    await submit({ labels: ['positive'] }, true);
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      answer: { labels: ['positive'] },
      fromSuggestion: true,
      suggestionUnchanged: true,
    });
  });

  it('records a suggestion that was changed, or not used', async () => {
    const changed = await claimed();
    await changed.submit({ labels: ['negative'] }, true);
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id: changed.id } })).toMatchObject({
      fromSuggestion: true,
      suggestionUnchanged: false,
    });
  });

  it('counts the answer, never the suggestion, in the consensus and in pay', async () => {
    const { id, submit } = await claimed();
    await submit({ labels: ['negative'] }, false);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ fromSuggestion: false, suggestionUnchanged: false });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: row.taskId } });
    expect(task.consensus).toEqual({ labels: ['negative'] });
    expect(task.suggestion).toEqual({ labels: ['positive'] });
    // nothing was made out of the suggestion: one submission, from the annotator
    expect(await prisma.assignment.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('shows on the quality page and in the export', async () => {
    const { project, pmCookie, submit } = await claimed();
    await submit({ labels: ['positive'] }, true);
    const quality = payload<{
      suggestions: {
        tasks: number;
        annotators: Array<{ withSuggestion: number; unchanged: number }>;
      };
    }>(
      await run(
        qualityLoader,
        makeRequest(`/projects/${project.id}/quality`, { cookie: pmCookie }),
        { projectId: project.id },
      ),
    );
    expect(quality.suggestions.tasks).toBe(2);
    expect(quality.suggestions.annotators).toEqual([
      expect.objectContaining({ name: 'Ann', withSuggestion: 1, unchanged: 1 }),
    ]);

    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=jsonl&scope=all`, { cookie: pmCookie }),
      { projectId: project.id },
    )) as Response;
    const [first] = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(first.suggestion).toEqual({ answer: { labels: ['positive'] }, source: 'file' });
    expect(first.annotations[0]).toMatchObject({
      from_suggestion: true,
      suggestion_unchanged: true,
    });
  });

  it('scores the rule against the gold answers on the quality page', async () => {
    const { project, pmCookie, importFile } = await world({ prelabel: rule });
    await importFile('text,_gold\nGreat,positive\nbroken,positive\n');
    await runDueJobs();
    const quality = payload<{
      suggestions: { againstGold: Array<{ source: string; tasks: number; score: number }> };
    }>(
      await run(
        qualityLoader,
        makeRequest(`/projects/${project.id}/quality`, { cookie: pmCookie }),
        { projectId: project.id },
      ),
    );
    expect(quality.suggestions.againstGold).toEqual([{ source: 'keywords', tasks: 2, score: 0.5 }]);
  });
});
