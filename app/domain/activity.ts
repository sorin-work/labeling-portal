/**
 * The audit trail: the actions it records, the shape of a settings change,
 * and the sentence each entry reads as on the activity tab and `/audit`.
 *
 * Entries never hold a secret or an answer. A password event says who and
 * whose. A settings change holds the instructions as two lengths. A review or
 * a gold edit names the task, not what was answered.
 */
import { centsToDecimal } from './payouts';
import { describeSchemaChange } from './schema-diff';

/** Every action the trail records, with how the filter on `/audit` names it. */
export const ACTIVITY_ACTIONS = {
  'project.created': 'Project created',
  'project.settings': 'Project settings changed',
  'project.status': 'Project launched, paused or archived',
  'project.duplicated': 'Project copied',
  'batch.imported': 'Batch imported',
  'batch.deleted': 'Batch deleted',
  'batch.priority': 'Batch priority changed',
  'batch.paused': 'Batch paused',
  'batch.resumed': 'Batch resumed',
  'task.adjudicated': 'Task settled in adjudication',
  'task.escalated': 'Task sent to adjudication',
  'member.added': 'Added to a project',
  'member.removed': 'Removed from a project',
  'qualification.reset': 'Qualification reset',
  'gold.created': 'Gold tasks made',
  'gold.edited': 'Gold answer changed',
  'gold.retired': 'Gold task retired',
  'gold.restored': 'Gold task brought back',
  'gold.rescored': 'Gold task rescored',
  'review.decided': 'Review decision',
  'dispute.resolved': 'Dispute settled',
  'person.added': 'Person added',
  'person.role': 'Role changed',
  'person.password': 'Password set by an admin',
  'person.removed': 'Person removed',
  'account.password': 'Own password changed',
  'token.created': 'API token made',
  'token.revoked': 'API token revoked',
  'auth.signed_in': 'Signed in',
  'auth.locked': 'Sign-in locked',
  'export.labels': 'Labels downloaded',
  'export.quality': 'Quality table downloaded',
  'export.payouts': 'Pay report downloaded',
} as const;

export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;

export function isActivityAction(value: unknown): value is ActivityAction {
  return typeof value === 'string' && Object.hasOwn(ACTIVITY_ACTIONS, value);
}

/** The project settings a `project.settings` entry compares. */
export type ProjectSettings = {
  name: string;
  description: string;
  instructions: string;
  overlap: number;
  timeLimitMinutes: number;
  reviewRequired: boolean;
  reviewSamplePercent: number;
  disputeWindowDays: number;
  goldFeedback: boolean;
  queueOrder: string;
  goldEvery: number | null;
  agreementThreshold: number | null;
  maxExtraAnnotators: number;
  qualificationRequired: boolean;
  qualificationPassPercent: number;
  payMode: string;
  rateCents: number;
};

const COMPARED = [
  'name',
  'description',
  'overlap',
  'timeLimitMinutes',
  'reviewRequired',
  'reviewSamplePercent',
  'disputeWindowDays',
  'goldFeedback',
  'queueOrder',
  'goldEvery',
  'agreementThreshold',
  'maxExtraAnnotators',
  'qualificationRequired',
  'qualificationPassPercent',
  'payMode',
  'rateCents',
] as const satisfies ReadonlyArray<keyof ProjectSettings>;

export type SettingsChanges = Record<string, [unknown, unknown]>;

/**
 * What a save changed, as `changes` in the shape the roadmap fixed: a field
 * name to `[before, after]`. Fields that stayed the same are left out. The
 * instructions are two lengths, not the text. The schema is not compared
 * here: `updateProject` adds the two schemas under `schema` when the schema
 * diff finds a change, so the entry can be diffed again when it is read.
 */
export function settingsChanges(before: ProjectSettings, after: ProjectSettings): SettingsChanges {
  const changes: SettingsChanges = {};
  for (const field of COMPARED) {
    if (before[field] !== after[field]) changes[field] = [before[field], after[field]];
  }
  if (before.instructions.trim() !== after.instructions.trim()) {
    changes.instructions = [before.instructions.length, after.instructions.length];
  }
  return changes;
}

const FIELD_NAMES: Record<string, string> = {
  name: 'the name',
  description: 'the description',
  overlap: 'the overlap',
  timeLimitMinutes: 'the time limit',
  reviewRequired: 'review',
  reviewSamplePercent: 'the review sample',
  disputeWindowDays: 'the dispute window',
  goldFeedback: 'gold feedback',
  queueOrder: 'the task order',
  goldEvery: 'gold spacing',
  agreementThreshold: 'the agreement threshold',
  maxExtraAnnotators: 'the extra annotators',
  qualificationRequired: 'the qualification test',
  qualificationPassPercent: 'the pass mark',
  payMode: 'the pay mode',
  rateCents: 'the rate',
};

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  switch (field) {
    case 'rateCents':
      return typeof value === 'number' ? `$${centsToDecimal(value)}` : String(value);
    case 'timeLimitMinutes':
      return `${String(value)} minutes`;
    case 'disputeWindowDays':
      return `${String(value)} days`;
    case 'reviewSamplePercent':
    case 'qualificationPassPercent':
      return `${String(value)}%`;
    case 'goldEvery':
      return `one in ${String(value)}`;
    case 'agreementThreshold':
    case 'maxExtraAnnotators':
      return String(value);
    case 'payMode':
      return value === 'HOURLY' ? 'hourly' : 'per task';
    case 'queueOrder':
      return String(value).toLowerCase();
    default:
      return `“${String(value)}”`;
  }
}

/** The parts of a settings entry as phrases: `the rate from $0.08 to $0.10`. */
export function describeSettingsChanges(changes: unknown): string[] {
  if (typeof changes !== 'object' || changes === null) return [];
  const map = changes as Record<string, unknown>;
  const parts: string[] = [];
  for (const [field, pair] of Object.entries(map)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    if (field === 'schema') {
      const schema = describeSchemaChange(pair);
      parts.push(schema.length ? `the task schema (${schema.join(', ')})` : 'the task schema');
    } else if (field === 'instructions') {
      parts.push(`the instructions (${String(pair[0])} to ${String(pair[1])} characters)`);
    } else {
      const name = FIELD_NAMES[field] ?? field;
      parts.push(`${name} from ${formatValue(field, pair[0])} to ${formatValue(field, pair[1])}`);
    }
  }
  return parts;
}

type Detail = Record<string, unknown>;

const DECISIONS: Record<string, string> = {
  APPROVE: 'approved',
  SEND_BACK: 'sent back',
  FIX: 'fixed',
};

function plural(n: unknown, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * An entry as a sentence that follows the actor's name. An action this does
 * not know, from a newer version, reads as its name.
 */
export function describeActivity(action: string, detail: unknown): string {
  const d: Detail = typeof detail === 'object' && detail !== null ? (detail as Detail) : {};
  const who = typeof d.userName === 'string' ? d.userName : 'someone';
  const project = typeof d.projectName === 'string' ? ` “${d.projectName}”` : '';
  switch (action as ActivityAction) {
    case 'project.created':
      return `created the project${project}`;
    case 'project.settings': {
      const parts = describeSettingsChanges(d.changes);
      return parts.length
        ? `changed ${parts.join('; ')}`
        : 'saved the project settings without changes';
    }
    case 'project.status':
      return `changed the status from ${String(d.from).toLowerCase()} to ${String(d.to).toLowerCase()}`;
    case 'project.duplicated':
      return 'made a copy of this project';
    case 'batch.imported':
      return `imported ${String(d.tasks)} tasks as “${String(d.name)}”${d.qualification ? ' (qualification test)' : ''}${d.via === 'api' ? ' through the API' : ''}`;
    case 'batch.deleted':
      return `deleted ${typeof d.name === 'string' ? `the batch “${d.name}” of` : 'a batch of'} ${plural(d.tasks, 'task')}`;
    case 'batch.priority':
      return `set the priority of “${String(d.name)}” to ${String(d.to)} (it was ${String(d.from)})`;
    case 'batch.paused':
      return `paused “${String(d.name)}”: nothing from it is handed out`;
    case 'batch.resumed':
      return `resumed “${String(d.name)}”`;
    case 'task.adjudicated':
      return `settled task #${String(d.position)} in adjudication (${
        d.how === 'own'
          ? 'with an answer of their own'
          : d.how === 'consensus'
            ? 'kept the consensus'
            : 'used one of the answers'
      })`;
    case 'task.escalated':
      return `sent task #${String(d.position)} to adjudication without waiting for an extra annotator`;
    case 'member.added':
      return `added ${who} to the project`;
    case 'member.removed':
      return `removed ${who} from the project`;
    case 'qualification.reset':
      return `reset the qualification of ${who}, removing ${plural(d.attempts, 'attempt')}`;
    case 'gold.created':
      return `made ${plural(d.tasks, 'gold task')} from completed tasks`;
    case 'gold.edited':
      return `changed the expected answer of gold task #${String(d.position)}: ${String(d.reason)}`;
    case 'gold.retired':
      return `retired gold task #${String(d.position)}: ${String(d.reason)}`;
    case 'gold.restored':
      return `brought gold task #${String(d.position)} back: ${String(d.reason)}`;
    case 'gold.rescored': {
      const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
      const flags = [
        count(d.newlyFlagged) ? `${count(d.newlyFlagged)} newly flagged` : '',
        count(d.noLongerFlagged) ? `${count(d.noLongerFlagged)} no longer flagged` : '',
      ].filter(Boolean);
      return `rescored gold task #${String(d.position)}: ${plural(d.scores, 'score')} changed for ${plural(d.annotators, 'annotator')}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    }
    case 'review.decided':
      return `${DECISIONS[String(d.decision)] ?? 'reviewed'} the work of ${who} on task #${String(d.position)} (QA ${String(d.qaScore)})`;
    case 'dispute.resolved':
      return `${d.outcome === 'OVERTURNED' ? 'overturned' : 'upheld'} a review of the work of ${who} on task #${String(d.position)} after a dispute`;
    case 'person.added':
      return `added ${who} as ${String(d.role).toLowerCase().replace('_', ' ')}`;
    case 'person.role':
      return `changed the role of ${who} from ${String(d.from).toLowerCase().replace('_', ' ')} to ${String(d.to).toLowerCase().replace('_', ' ')}`;
    case 'person.password':
      return `set a new password for ${who}`;
    case 'person.removed':
      return `removed ${who} from the organisation`;
    case 'account.password':
      return 'changed their own password';
    case 'token.created':
      return `made the ${d.readOnly === false ? 'read and write' : 'read-only'} API token “${String(d.name)}” (${String(d.prefix)}…)`;
    case 'token.revoked':
      return `revoked the API token “${String(d.name)}” (${String(d.prefix)}…)`;
    case 'auth.signed_in':
      return 'signed in';
    case 'auth.locked':
      return 'was locked out of signing in after too many failed attempts';
    case 'export.labels':
      return `downloaded the labels${project} as ${String(d.format)}${d.batch ? ', one batch' : ''}${d.annotators === 'email' ? ', with email addresses' : ''}${d.via === 'api' ? ', through the API' : ''}`;
    case 'export.quality':
      return `downloaded the quality table${project}`;
    case 'export.payouts':
      return `downloaded the pay report for ${String(d.from)} to ${String(d.to)}${project}`;
    default:
      return action;
  }
}
