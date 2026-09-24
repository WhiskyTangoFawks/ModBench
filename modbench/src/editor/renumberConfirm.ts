import type { ReferenceResult } from '../client';

/** The records a list of references comes from: a record holding the reference in several fields
 *  is one record, and each copy of a plugin is its own (ADR-0012). */
export function referencingRecords(references: readonly ReferenceResult[]): number {
  return new Set(references.map((r) => JSON.stringify([r.origin, r.plugin, r.formKey]))).size;
}

/** Renumber leaves every reference to its records pointing at nothing, so it asks only when there
 *  is one, saying how many. Null when there is none. `references` is undefined when it could not
 *  be counted. */
export function renumberConfirmMessage(labels: readonly string[], references: number | undefined): string | null {
  if (references === 0) return null;
  const [only] = labels;
  const single = labels.length === 1 && only !== undefined;
  const question = `Renumber ${single ? only : `${labels.length} records`}?`;
  const them = single ? 'it' : 'them';
  if (references === undefined) {
    return `${question} ${single ? 'Its' : 'Their'} references could not be counted: `
      + `any record that references ${them} will point at nothing until it is updated.`;
  }
  return references === 1
    ? `${question} 1 record that references ${them} will point at nothing until it is updated.`
    : `${question} ${references} records that reference ${them} will point at nothing until they are updated.`;
}
