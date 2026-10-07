import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** The refusal of a new mod whose name a folder already holds: one wording for create and install. */
export const modNameTakenRefusal = (name: string): string =>
  `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;

/** Why a new mod may not take `name`, trimmed: a folder already holds a mod of that name, matched
 *  as the manager matches names. Undefined for a free name, or a blank one. */
export async function newModNameRefusal(adapter: Pick<InstanceAdapter, 'entryFolder'>, name: string): Promise<string | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return (await adapter.entryFolder({ kind: 'mod', name: trimmed })) === undefined ? undefined : modNameTakenRefusal(trimmed);
}

/** The refusal of a mark on a file that is gone. */
export const goneFromDisk = (name: string): string => `"${name}" is gone from disk.`;
