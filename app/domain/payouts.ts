export type PayMode = 'PER_TASK' | 'HOURLY';

/** One accepted submission, with the rate of the project it belongs to. */
export type PaidWork = {
  userId: string;
  name: string;
  email: string;
  projectId: string;
  projectName: string;
  payMode: PayMode;
  rateCents: number;
  activeSeconds: number;
};

export type ProjectPayout = {
  projectId: string;
  projectName: string;
  payMode: PayMode;
  rateCents: number;
  tasks: number;
  seconds: number;
  amountCents: number;
};

export type PayoutLine = {
  userId: string;
  name: string;
  email: string;
  tasks: number;
  seconds: number;
  amountCents: number;
  projects: ProjectPayout[];
};

/**
 * What a block of work earns: the flat rate per task, or the hourly rate for
 * the total time. Hourly amounts are rounded once, to the nearest cent, for the
 * whole block rather than per task.
 */
export function amountCents(
  mode: PayMode,
  rateCents: number,
  tasks: number,
  seconds: number,
): number {
  if (mode === 'PER_TASK') return rateCents * tasks;
  return Math.round((rateCents * seconds) / 3600);
}

/** Groups accepted work by person and project and adds up what each person is owed. */
export function computePayouts(work: PaidWork[]): { lines: PayoutLine[]; totalCents: number } {
  const lines = new Map<string, PayoutLine>();
  for (const item of work) {
    const line =
      lines.get(item.userId) ??
      ({
        userId: item.userId,
        name: item.name,
        email: item.email,
        tasks: 0,
        seconds: 0,
        amountCents: 0,
        projects: [],
      } satisfies PayoutLine);
    lines.set(item.userId, line);

    let project = line.projects.find((p) => p.projectId === item.projectId);
    if (!project) {
      project = {
        projectId: item.projectId,
        projectName: item.projectName,
        payMode: item.payMode,
        rateCents: item.rateCents,
        tasks: 0,
        seconds: 0,
        amountCents: 0,
      };
      line.projects.push(project);
    }
    project.tasks += 1;
    project.seconds += item.activeSeconds;
    line.tasks += 1;
    line.seconds += item.activeSeconds;
  }
  for (const line of lines.values()) {
    for (const p of line.projects)
      p.amountCents = amountCents(p.payMode, p.rateCents, p.tasks, p.seconds);
    line.amountCents = line.projects.reduce((s, p) => s + p.amountCents, 0);
  }
  const sorted = [...lines.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const line of sorted)
    line.projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return { lines: sorted, totalCents: sorted.reduce((s, l) => s + l.amountCents, 0) };
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Parses "12.50" style money input into cents. */
export function parseMoney(input: string): number | null {
  const text = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
