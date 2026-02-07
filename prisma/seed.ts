/**
 * Demo data: one organisation with a user for every role. Safe to run more
 * than once; it does nothing when the demo organisation already exists.
 *
 *   npm run db:seed
 */
import { PrismaClient, type Prisma, type Role, type TaskKind } from '@prisma/client';
import bcrypt from 'bcryptjs';

import { INSTRUCTIONS, newsRows, pairwiseRows, reviewRows, streetRows } from './seed-data';

const prisma = new PrismaClient();

export const DEMO_PASSWORD = 'labeling-demo';

const PEOPLE: Array<{ email: string; name: string; role: Role }> = [
  { email: 'admin@example.com', name: 'Alex Morgan', role: 'ADMIN' },
  { email: 'pm@example.com', name: 'Priya Natarajan', role: 'PROJECT_MANAGER' },
  { email: 'reviewer@example.com', name: 'Rafael Costa', role: 'REVIEWER' },
  { email: 'annotator@example.com', name: 'Ana Lindqvist', role: 'ANNOTATOR' },
  { email: 'annotator2@example.com', name: 'Ben Okafor', role: 'ANNOTATOR' },
  { email: 'annotator3@example.com', name: 'Chen Wei', role: 'ANNOTATOR' },
];

async function main() {
  const existing = await prisma.organization.findUnique({ where: { slug: 'harbor-data' } });
  if (existing) {
    console.log('demo organisation already exists, skipping seed');
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const org = await prisma.organization.create({
    data: { name: 'Harbor Data Labs', slug: 'harbor-data' },
  });

  const users = [];
  for (const person of PEOPLE) {
    users.push(
      await prisma.user.create({
        data: {
          email: person.email,
          name: person.name,
          passwordHash,
          memberships: { create: { orgId: org.id, role: person.role } },
        },
      }),
    );
  }
  const workers = users.filter((_, i) => ['REVIEWER', 'ANNOTATOR'].includes(PEOPLE[i].role));

  const projects: Array<{
    name: string;
    description: string;
    instructions: string;
    kind: TaskKind;
    schema: Prisma.InputJsonValue;
    overlap: number;
    timeLimitMinutes: number;
    rows: Array<Record<string, unknown>>;
  }> = [
    {
      name: 'Product review sentiment',
      description: 'Classify customer reviews as positive, neutral or negative.',
      instructions: INSTRUCTIONS.sentiment,
      kind: 'TEXT_CLASSIFICATION',
      schema: {
        kind: 'text_classification',
        textField: 'text',
        labels: ['positive', 'neutral', 'negative'],
        multiple: false,
      },
      overlap: 2,
      timeLimitMinutes: 10,
      rows: reviewRows(36),
    },
    {
      name: 'News entity tagging',
      description: 'Highlight people, organisations and places in news sentences.',
      instructions: INSTRUCTIONS.ner,
      kind: 'NER',
      schema: {
        kind: 'ner',
        textField: 'text',
        entities: [
          { name: 'PERSON', color: '#f59e0b' },
          { name: 'ORG', color: '#6366f1' },
          { name: 'LOCATION', color: '#10b981' },
        ],
      },
      overlap: 1,
      timeLimitMinutes: 15,
      rows: newsRows,
    },
    {
      name: 'Assistant response comparison',
      description: 'Compare two assistant answers with a rubric and pick the better one.',
      instructions: INSTRUCTIONS.pairwise,
      kind: 'PAIRWISE',
      schema: {
        kind: 'pairwise',
        promptField: 'prompt',
        responseAField: 'response_a',
        responseBField: 'response_b',
        dimensions: [
          { key: 'helpfulness', label: 'Helpfulness', description: 'Does it do what was asked?' },
          { key: 'accuracy', label: 'Accuracy', description: 'Are facts and reasoning correct?' },
          { key: 'safety', label: 'Safety', description: 'Does it avoid harmful advice?' },
        ],
        allowTie: true,
        minRationaleLength: 30,
      },
      overlap: 2,
      timeLimitMinutes: 20,
      rows: pairwiseRows,
    },
    {
      name: 'Street scene objects',
      description: 'Draw boxes around cars and people in street images.',
      instructions: INSTRUCTIONS.boxes,
      kind: 'BBOX',
      schema: { kind: 'bbox', imageField: 'image_url', labels: ['car', 'person'], minBoxSize: 6 },
      overlap: 1,
      timeLimitMinutes: 15,
      rows: streetRows,
    },
  ];

  for (const spec of projects) {
    const project = await prisma.project.create({
      data: {
        orgId: org.id,
        name: spec.name,
        description: spec.description,
        instructions: spec.instructions,
        kind: spec.kind,
        schema: spec.schema,
        status: 'ACTIVE',
        overlap: spec.overlap,
        timeLimitMinutes: spec.timeLimitMinutes,
        members: { create: workers.map((u) => ({ userId: u.id })) },
      },
    });
    const batch = await prisma.batch.create({
      data: { projectId: project.id, name: 'Demo batch', format: 'JSONL' },
    });
    await prisma.task.createMany({
      data: spec.rows.map((row, i) => {
        const { id, ...data } = row;
        return {
          projectId: project.id,
          batchId: batch.id,
          externalId: String(id),
          position: i + 1,
          data: { id, ...data } as Prisma.InputJsonValue,
        };
      }),
    });
  }

  console.log(
    `seeded ${org.name}: ${PEOPLE.length} users, ${projects.length} projects (password: ${DEMO_PASSWORD})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
