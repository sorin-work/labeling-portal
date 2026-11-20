/** How many characters of an assignment id make up its reference. */
const REF_LENGTH = 6;

/**
 * A short reference for a claim or submission, for an annotator to quote when
 * they report a problem with a task. It is cut from the assignment's id, so
 * it is of the same form for every task and says nothing about the task, its
 * batch or where it came from. The task page and the batch search resolve it.
 */
export function assignmentRef(assignmentId: string): string {
  return assignmentId.slice(-REF_LENGTH).toUpperCase();
}

/** The end of an assignment id that a typed reference stands for, or null when it is not one. */
export function refSuffix(text: string): string | null {
  const cleaned = text.trim().replace(/^ref[\s:#]*/i, '');
  return /^[a-z0-9]{6}$/i.test(cleaned) ? cleaned.toLowerCase() : null;
}
