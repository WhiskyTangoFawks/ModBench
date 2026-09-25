import { FOLDER_KEY } from '../folderContext';

export const IN_AN_INSTANCE = `${FOLDER_KEY} == instance`;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether `when` holds only while `term` does: the term is a conjunct of every `||` alternative,
 *  and no parenthesis regroups them. */
export function requires(when: string | undefined, term: string): boolean {
  return when !== undefined && !/[()]/.test(when)
    && when.split('||').every((alternative) => alternative.split('&&').map((t) => t.trim()).includes(term));
}
