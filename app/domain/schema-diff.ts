import {
  KIND_LABELS,
  parseTaskSchema,
  type BboxSchema,
  type NerSchema,
  type PairwiseSchema,
  type TaskSchema,
  type TextClassificationSchema,
} from './task-schema';

/**
 * What the stored work of a project uses from its schema. `diffSchema` needs
 * these counts to tell a harmless edit from one that would orphan answers.
 *
 * "Stored answers" are submissions, reviewer corrections, gold answers,
 * consensus answers, the answer a dispute was about (once the submission has
 * moved on from it), the expected answers a gold task had before it was
 * edited, and the answers of qualification attempts.
 */
export type SchemaUsage = {
  /** Imported tasks, gold and qualification tasks included. */
  tasks: number;
  /** Stored answers of any shape. */
  answers: number;
  /** Label, entity type or box label -> stored answers that use it. */
  names: ReadonlyMap<string, number>;
  /** Classification answers with two or more labels. */
  multiLabel: number;
  /** Pairwise answers whose preference is a tie. */
  ties: number;
  /** Pairwise answers that carry rubric scores. Gold answers only hold a preference. */
  scored: number;
  /** Rubric dimension key -> scored answers with a score for it on both sides. */
  dimensions: ReadonlyMap<string, number>;
};

/** A project without tasks or answers: every edit is safe. */
export const NO_USAGE: SchemaUsage = {
  tasks: 0,
  answers: 0,
  names: new Map(),
  multiLabel: 0,
  ties: 0,
  scored: 0,
  dimensions: new Map(),
};

export type SchemaChange = {
  /** The schema property that changed, for example `labels` or `textField`. */
  field: string;
  /**
   * `breaking` changes are refused. A `warning` saves, but leaves something
   * behind that the manager should know about.
   */
  impact: 'safe' | 'warning' | 'breaking';
  /** What changed, worded to follow a name: `removed the label “spam”`. */
  summary: string;
  /** Why the change is refused, or what it leaves behind. Empty for safe changes. */
  reason: string;
  /** The tasks or stored answers the reason counts. 0 for safe changes. */
  affected: number;
};

/** The way out the settings page offers when a change is refused. */
export const REDESIGN_HINT =
  'For a redesign, use “Duplicate project”: it copies the setup into a new draft without tasks.';

function safe(field: string, summary: string): SchemaChange {
  return { field, impact: 'safe', summary, reason: '', affected: 0 };
}

function answers(n: number): string {
  return n === 1 ? '1 stored answer' : `${n} stored answers`;
}

function kindChange(before: TaskSchema, after: TaskSchema, usage: SchemaUsage): SchemaChange {
  const name = (schema: TaskSchema) => KIND_LABELS[schema.kind].toLowerCase();
  const summary = `changed the kind from ${name(before)} to ${name(after)}`;
  if (usage.tasks > 0) {
    return {
      field: 'kind',
      impact: 'breaking',
      summary,
      reason: `the kind cannot change once the project has ${usage.tasks === 1 ? '1 task' : `${usage.tasks} tasks`}`,
      affected: usage.tasks,
    };
  }
  if (usage.answers > 0) {
    return {
      field: 'kind',
      impact: 'breaking',
      summary,
      reason: `the kind cannot change once the project has ${answers(usage.answers)}`,
      affected: usage.answers,
    };
  }
  return safe('kind', summary);
}

/** The imported rows only have the field they were imported with. */
function fieldChange(
  field: string,
  before: string,
  after: string,
  usage: SchemaUsage,
): SchemaChange[] {
  if (before === after) return [];
  const summary = `changed ${field} from “${before}” to “${after}”`;
  if (usage.tasks === 0) return [safe(field, summary)];
  const imported = usage.tasks === 1 ? '1 task was' : `${usage.tasks} tasks were`;
  return [
    {
      field,
      impact: 'breaking',
      summary,
      reason: `${field} cannot change after ${imported} imported with “${before}”`,
      affected: usage.tasks,
    },
  ];
}

/** True when the names both lists share come in a different order. */
function reordered(before: string[], after: string[]): boolean {
  const keptBefore = before.filter((name) => after.includes(name));
  const keptAfter = after.filter((name) => before.includes(name));
  return keptBefore.some((name, i) => name !== keptAfter[i]);
}

/**
 * Labels, entity types and box labels. Names are compared exactly, the way
 * answers are validated, so a rename (also one that only changes case) is a
 * removal plus an addition.
 */
function nameChanges(
  naming: { field: string; one: string; many: string },
  before: string[],
  after: string[],
  usage: SchemaUsage,
): SchemaChange[] {
  const { field, one, many } = naming;
  const changes: SchemaChange[] = [];
  for (const name of before) {
    if (after.includes(name)) continue;
    const used = usage.names.get(name) ?? 0;
    const summary = `removed the ${one} “${name}”`;
    if (used === 0) {
      changes.push(safe(field, summary));
      continue;
    }
    changes.push({
      field,
      impact: 'breaking',
      summary,
      reason: `the ${one} “${name}” cannot be removed or renamed while ${answers(used)} ${used === 1 ? 'uses' : 'use'} it`,
      affected: used,
    });
  }
  for (const name of after) {
    if (!before.includes(name)) changes.push(safe(field, `added the ${one} “${name}”`));
  }
  if (reordered(before, after)) changes.push(safe(field, `reordered the ${many}`));
  return changes;
}

function classificationChanges(
  before: TextClassificationSchema,
  after: TextClassificationSchema,
  usage: SchemaUsage,
): SchemaChange[] {
  const changes = [
    ...fieldChange('textField', before.textField, after.textField, usage),
    ...nameChanges(
      { field: 'labels', one: 'label', many: 'labels' },
      before.labels,
      after.labels,
      usage,
    ),
  ];
  if (before.multiple && !after.multiple) {
    const summary = 'turned off “multiple”';
    changes.push(
      usage.multiLabel === 0
        ? safe('multiple', summary)
        : {
            field: 'multiple',
            impact: 'breaking',
            summary,
            reason: `“multiple” cannot be turned off while ${answers(usage.multiLabel)} ${usage.multiLabel === 1 ? 'has' : 'have'} more than one label`,
            affected: usage.multiLabel,
          },
    );
  }
  if (!before.multiple && after.multiple) changes.push(safe('multiple', 'turned on “multiple”'));
  return changes;
}

function nerChanges(before: NerSchema, after: NerSchema, usage: SchemaUsage): SchemaChange[] {
  const changes = [
    ...fieldChange('textField', before.textField, after.textField, usage),
    ...nameChanges(
      { field: 'entities', one: 'entity type', many: 'entity types' },
      before.entities.map((e) => e.name),
      after.entities.map((e) => e.name),
      usage,
    ),
  ];
  for (const entity of after.entities) {
    const old = before.entities.find((e) => e.name === entity.name);
    if (old && old.color !== entity.color) {
      changes.push(safe('entities', `changed the colour of “${entity.name}”`));
    }
  }
  return changes;
}

/**
 * Rubric dimensions. An added dimension has no score on the answers that are
 * already stored, so it is refused while such answers exist. A removed one
 * only leaves numbers behind that nothing reads any more.
 */
function dimensionChanges(
  before: PairwiseSchema,
  after: PairwiseSchema,
  usage: SchemaUsage,
): SchemaChange[] {
  const field = 'dimensions';
  const beforeKeys = before.dimensions.map((d) => d.key);
  const afterKeys = after.dimensions.map((d) => d.key);
  const changes: SchemaChange[] = [];
  for (const key of beforeKeys) {
    if (afterKeys.includes(key)) continue;
    const kept = usage.dimensions.get(key) ?? 0;
    const summary = `removed the rubric dimension “${key}”`;
    if (kept === 0) {
      changes.push(safe(field, summary));
      continue;
    }
    changes.push({
      field,
      impact: 'warning',
      summary,
      reason: `removing “${key}” leaves its scores on ${answers(kept)}; the CSV export and new consensus answers leave them out`,
      affected: kept,
    });
  }
  for (const key of afterKeys) {
    if (beforeKeys.includes(key)) continue;
    const missing = Math.max(0, usage.scored - (usage.dimensions.get(key) ?? 0));
    const summary = `added the rubric dimension “${key}”`;
    if (missing === 0) {
      changes.push(safe(field, summary));
      continue;
    }
    changes.push({
      field,
      impact: 'breaking',
      summary,
      reason: `the rubric dimension “${key}” cannot be added while ${answers(missing)} ${missing === 1 ? 'has' : 'have'} no score for it`,
      affected: missing,
    });
  }
  for (const dimension of after.dimensions) {
    const old = before.dimensions.find((d) => d.key === dimension.key);
    if (old && (old.label !== dimension.label || old.description !== dimension.description)) {
      changes.push(safe(field, `reworded the rubric dimension “${dimension.key}”`));
    }
  }
  if (reordered(beforeKeys, afterKeys))
    changes.push(safe(field, 'reordered the rubric dimensions'));
  return changes;
}

function pairwiseChanges(
  before: PairwiseSchema,
  after: PairwiseSchema,
  usage: SchemaUsage,
): SchemaChange[] {
  const changes = [
    ...fieldChange('promptField', before.promptField, after.promptField, usage),
    ...fieldChange('responseAField', before.responseAField, after.responseAField, usage),
    ...fieldChange('responseBField', before.responseBField, after.responseBField, usage),
    ...dimensionChanges(before, after, usage),
  ];
  if (before.allowTie && !after.allowTie) {
    const summary = 'turned off “allowTie”';
    changes.push(
      usage.ties === 0
        ? safe('allowTie', summary)
        : {
            field: 'allowTie',
            impact: 'breaking',
            summary,
            reason: `“allowTie” cannot be turned off while ${answers(usage.ties)} ${usage.ties === 1 ? 'is a tie' : 'are ties'}`,
            affected: usage.ties,
          },
    );
  }
  if (!before.allowTie && after.allowTie) changes.push(safe('allowTie', 'turned on “allowTie”'));
  if (before.minRationaleLength !== after.minRationaleLength) {
    changes.push(
      safe(
        'minRationaleLength',
        `changed minRationaleLength from ${before.minRationaleLength} to ${after.minRationaleLength}`,
      ),
    );
  }
  return changes;
}

function bboxChanges(before: BboxSchema, after: BboxSchema, usage: SchemaUsage): SchemaChange[] {
  const changes = [
    ...fieldChange('imageField', before.imageField, after.imageField, usage),
    ...nameChanges(
      { field: 'labels', one: 'box label', many: 'box labels' },
      before.labels,
      after.labels,
      usage,
    ),
  ];
  if (before.minBoxSize !== after.minBoxSize) {
    changes.push(
      safe('minBoxSize', `changed minBoxSize from ${before.minBoxSize} to ${after.minBoxSize}`),
    );
  }
  return changes;
}

/**
 * Lists what an edit changes in a task schema. Every difference between the
 * two schemas gives at least one change, so an empty list means they are the
 * same. Without `usage` the project is taken to be empty and nothing breaks,
 * which is what the activity page wants when it only describes an old edit.
 */
export function diffSchema(
  before: TaskSchema,
  after: TaskSchema,
  usage: SchemaUsage = NO_USAGE,
): SchemaChange[] {
  // every other property means something else in another kind
  if (before.kind !== after.kind) return [kindChange(before, after, usage)];
  switch (before.kind) {
    case 'text_classification':
      return classificationChanges(before, after as TextClassificationSchema, usage);
    case 'ner':
      return nerChanges(before, after as NerSchema, usage);
    case 'pairwise':
      return pairwiseChanges(before, after as PairwiseSchema, usage);
    case 'bbox':
      return bboxChanges(before, after as BboxSchema, usage);
  }
}

export function breakingChanges(changes: SchemaChange[]): SchemaChange[] {
  return changes.filter((change) => change.impact === 'breaking');
}

/** The error for a refused save: what breaks, how much work it touches and the way out. */
export function refusalMessage(breaking: SchemaChange[]): string {
  const reasons = breaking.map((change) => change.reason).join('; ');
  return `Not saved. This would break work that already exists: ${reasons}. ${REDESIGN_HINT}`;
}

/**
 * Words the `[before, after]` pair an activity entry keeps under
 * `detail.changes.schema`. Returns nothing when the pair cannot be read.
 */
export function describeSchemaChange(pair: unknown): string[] {
  if (!Array.isArray(pair) || pair.length !== 2) return [];
  const before = parseTaskSchema(pair[0]);
  const after = parseTaskSchema(pair[1]);
  if (!before.ok || !after.ok) return [];
  return diffSchema(before.schema, after.schema).map((change) => change.summary);
}
