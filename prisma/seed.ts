/**
 * Demo data: one organisation with a user for every role. Safe to run more
 * than once; it does nothing when the demo organisation already exists.
 *
 *   npm run db:seed
 */
import { PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

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

  for (const person of PEOPLE) {
    await prisma.user.create({
      data: {
        email: person.email,
        name: person.name,
        passwordHash,
        memberships: { create: { orgId: org.id, role: person.role } },
      },
    });
  }

  console.log(`seeded ${org.name} with ${PEOPLE.length} users (password: ${DEMO_PASSWORD})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
