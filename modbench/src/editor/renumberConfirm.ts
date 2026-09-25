import type { ReferenceResult } from '../client';

/** A record a renumber is asked of: the FormKey, and the plugin copy that holds it (ADR-0012). */
export interface RenumberTarget { formKey: string; plugin: string; origin?: string }

/** The records left pointing at nothing once the targets are renumbered, each counted once however
 *  many fields or targets it references. A target's reference to itself is not another record's. */
export function danglingReferencers(
  referencesByTarget: readonly (readonly [RenumberTarget, readonly ReferenceResult[]])[],
): number {
  const referencers = new Set<string>();
  for (const [target, references] of referencesByTarget) {
    for (const r of references) {
      if (!isItself(target, r)) referencers.add(JSON.stringify([r.origin, r.plugin.toLowerCase(), r.formKey]));
    }
  }
  return referencers.size;
}

function isItself(target: RenumberTarget, reference: ReferenceResult): boolean {
  return reference.formKey === target.formKey
    && reference.plugin.toLowerCase() === target.plugin.toLowerCase()
    && (target.origin === undefined || reference.origin === target.origin);
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
