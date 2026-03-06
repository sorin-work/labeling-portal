import type { ProjectStatus, ReviewStatus, TaskKind } from '@prisma/client';

export const KIND_NAMES: Record<TaskKind, string> = {
  TEXT_CLASSIFICATION: 'Text classification',
  NER: 'Named entities',
  PAIRWISE: 'Pairwise comparison',
  BBOX: 'Bounding boxes',
};

export const STATUS_TONES: Record<ProjectStatus, 'slate' | 'emerald' | 'amber' | 'rose'> = {
  DRAFT: 'slate',
  ACTIVE: 'emerald',
  PAUSED: 'amber',
  ARCHIVED: 'rose',
};

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatDate(value: Date | string): string {
  return dateFormat.format(new Date(value));
}

export function formatDateTime(value: Date | string): string {
  return `${dateTimeFormat.format(new Date(value))} UTC`;
}

export function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

export const REVIEW_BADGES: Record<
  ReviewStatus,
  { label: string; tone: 'slate' | 'emerald' | 'amber' | 'sky' }
> = {
  PENDING: { label: 'Waiting for review', tone: 'slate' },
  APPROVED: { label: 'Approved', tone: 'emerald' },
  SENT_BACK: { label: 'Needs changes', tone: 'amber' },
  FIXED: { label: 'Corrected by reviewer', tone: 'sky' },
  NOT_REQUIRED: { label: 'Accepted', tone: 'emerald' },
};
