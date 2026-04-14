/**
 * Simulated history for the demo organisation: a few weeks of submissions,
 * reviews, gold answers and a qualification test, so the quality, review and
 * payout pages have something to show on first start.
 */
import type { Prisma, PrismaClient, ReviewStatus } from '@prisma/client';

import type { Answer } from '../app/domain/answers';
import { consensus } from '../app/domain/consensus';
import { scoreAgainstGold } from '../app/domain/gold';
import { parseTaskSchema } from '../app/domain/task-schema';

type Ids = { reviewer: string; annotators: string[] };

const DAY = 24 * 60 * 60 * 1000;

let seed = 42;
function rand(): number {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

function at(daysAgo: number, hour: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, Math.floor(rand() * 60), 0, 0);
  return d;
}

const SENTIMENT = ['positive', 'neutral', 'negative'];

async function submit(
  prisma: PrismaClient,
  input: {
    projectId: string;
    taskId: string;
    userId: string;
    answer: Answer;
    submittedAt: Date;
    seconds: number;
    reviewStatus: ReviewStatus;
    goldScore?: number | null;
  },
) {
  return prisma.assignment.create({
    data: {
      projectId: input.projectId,
      taskId: input.taskId,
      userId: input.userId,
      status: 'SUBMITTED',
      claimedAt: new Date(input.submittedAt.getTime() - input.seconds * 1000 - 20_000),
      expiresAt: new Date(input.submittedAt.getTime() + 10 * 60_000),
      submittedAt: input.submittedAt,
      activeSeconds: input.seconds,
      answer: input.answer as Prisma.InputJsonValue,
      reviewStatus: input.reviewStatus,
      goldScore: input.goldScore ?? null,
    },
  });
}

async function complete(
  prisma: PrismaClient,
  taskId: string,
  schemaJson: unknown,
  answers: Answer[],
) {
  const schema = parseTaskSchema(schemaJson);
  if (!schema.ok) return;
  const merged = consensus(schema.schema, answers);
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'COMPLETE',
      completedAt: new Date(),
      consensus: (merged.answer ?? undefined) as Prisma.InputJsonValue | undefined,
      agreement: merged.agreement,
    },
  });
}

/** Sentiment: gold tasks, two annotators per task, reviews with QA scores. */
export async function seedSentimentActivity(prisma: PrismaClient, projectId: string, ids: Ids) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const tasks = await prisma.task.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
  const truth = (position: number) => SENTIMENT[(position - 1) % 3];

  // every sixth task is a honeypot with a known answer
  for (const task of tasks.filter((t) => t.position % 6 === 0)) {
    await prisma.task.update({
      where: { id: task.id },
      data: { isGold: true, goldAnswer: { labels: [truth(task.position)] } },
    });
  }

  const [ben, chen] = ids.annotators.slice(1);
  const accuracy = new Map([
    [ben, 0.9],
    [chen, 0.75],
  ]);
  const regular = tasks.filter((t) => t.position % 6 !== 0).slice(0, 18);
  const gold = tasks.filter((t) => t.position % 6 === 0).slice(0, 3);

  for (const [i, task] of regular.entries()) {
    const answers: Answer[] = [];
    let accepted = 0;
    for (const userId of [ben, chen]) {
      const right = rand() < accuracy.get(userId)!;
      const label = right ? truth(task.position) : SENTIMENT[(task.position + 1) % 3];
      const pendingReview = i >= 14;
      const sendBack = !pendingReview && !right && rand() < 0.5;
      const status: ReviewStatus = pendingReview ? 'PENDING' : sendBack ? 'SENT_BACK' : 'APPROVED';
      const assignment = await submit(prisma, {
        projectId,
        taskId: task.id,
        userId,
        answer: { labels: [label] },
        submittedAt: at(20 - i, 18 + (userId === ben ? 1 : 3)),
        seconds: 25 + Math.floor(rand() * 50),
        reviewStatus: status,
      });
      if (!pendingReview) {
        await prisma.review.create({
          data: {
            assignmentId: assignment.id,
            reviewerId: ids.reviewer,
            decision: sendBack ? 'SEND_BACK' : 'APPROVE',
            qaScore: right ? 4 + Math.round(rand()) : 2,
            feedback: sendBack ? 'Read the whole review: the complaint is the main point.' : '',
            createdAt: at(19 - i, 21),
          },
        });
      }
      if (status === 'APPROVED') {
        accepted += 1;
        answers.push({ labels: [label] });
      }
    }
    if (accepted >= project.overlap) await complete(prisma, task.id, project.schema, answers);
  }

  const schema = parseTaskSchema(project.schema);
  for (const [i, task] of gold.entries()) {
    for (const userId of [ben, chen]) {
      const right = rand() < accuracy.get(userId)!;
      const answer = { labels: [right ? truth(task.position) : 'neutral'] };
      await submit(prisma, {
        projectId,
        taskId: task.id,
        userId,
        answer,
        submittedAt: at(15 - i * 3, 20),
        seconds: 30,
        reviewStatus: 'NOT_REQUIRED',
        goldScore: schema.ok
          ? scoreAgainstGold(schema.schema, answer, { labels: [truth(task.position)] })
          : null,
      });
    }
  }
}

/** Pairwise: a qualification test, two qualified annotators and some reviewed work. */
export async function seedPairwiseActivity(
  prisma: PrismaClient,
  projectId: string,
  batchId: string,
  ids: Ids,
) {
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { qualificationRequired: true, qualificationPassPercent: 70 },
  });
  const questions = [
    {
      prompt: 'What is the capital of Australia?',
      response_a: 'Sydney is the capital of Australia.',
      response_b: 'Canberra is the capital of Australia.',
      gold: 'B',
    },
    {
      prompt: 'Give one tip for better sleep.',
      response_a: 'Keep a regular schedule: go to bed and get up at the same time every day.',
      response_b: 'Sleep is important for health.',
      gold: 'A',
    },
    {
      prompt: 'Translate "thank you" into Spanish.',
      response_a: 'Gracias.',
      response_b: '"Thank you" in Spanish is "gracias".',
      gold: 'tie',
    },
  ];
  const last = await prisma.task.aggregate({ where: { projectId }, _max: { position: true } });
  let position = (last._max.position ?? 0) + 100;
  for (const q of questions) {
    const { gold, ...data } = q;
    await prisma.task.create({
      data: {
        projectId,
        batchId,
        position: position++,
        data,
        isQualification: true,
        goldAnswer: { preference: gold, scores: { a: {}, b: {} }, rationale: '' },
      },
    });
  }

  const [, ben, chen] = ids.annotators;
  const qualifiedAt = at(25, 19);
  await prisma.projectMember.updateMany({
    where: { projectId, userId: { in: [ben, chen] } },
    data: { qualifiedAt },
  });
  for (const userId of [ben, chen]) {
    await prisma.qualificationAttempt.create({
      data: {
        projectId,
        userId,
        scorePercent: 100,
        passed: true,
        answers: {},
        createdAt: qualifiedAt,
      },
    });
  }

  const tasks = await prisma.task.findMany({
    where: { projectId, isQualification: false },
    orderBy: { position: 'asc' },
    take: 4,
  });
  const dims = ['helpfulness', 'accuracy', 'safety'];
  const scores = (good: boolean) =>
    Object.fromEntries(dims.map((d) => [d, good ? 4 + Math.round(rand()) : 2]));
  for (const [i, task] of tasks.entries()) {
    const answers: Answer[] = [];
    for (const userId of [ben, chen]) {
      const answer = {
        preference: 'A' as const,
        scores: { a: scores(true), b: scores(false) },
        rationale: 'Response A answers the question directly and correctly; B is vague or wrong.',
      };
      const a = await submit(prisma, {
        projectId,
        taskId: task.id,
        userId,
        answer,
        submittedAt: at(12 - i * 2, 20),
        seconds: 150 + Math.floor(rand() * 200),
        reviewStatus: i < 3 ? 'APPROVED' : 'PENDING',
      });
      if (i < 3) {
        answers.push(answer);
        await prisma.review.create({
          data: {
            assignmentId: a.id,
            reviewerId: ids.reviewer,
            decision: 'APPROVE',
            qaScore: 5,
            createdAt: at(11 - i * 2, 21),
          },
        });
      }
    }
    if (answers.length >= project.overlap) await complete(prisma, task.id, project.schema, answers);
  }
}
