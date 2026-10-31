import type { Read } from '../repositoriesLib/statusValues';

/** Why this machine does not hold the installation file a manifest pins by `name` and `hash`, given the downloaded file of
 *  that name as it reads; undefined when it holds it. */
export function installationFileLack(pinned: { readonly name: string; readonly hash: string }, read: Read<{ readonly hash: string } | undefined>): string | undefined {
  if (read.kind === 'unreadable') return `installation file '${pinned.name}' could not be read: ${read.reason}`;
  if (read.answer === undefined) return `installation file '${pinned.name}' is missing`;
  return read.answer.hash === pinned.hash ? undefined : `installation file '${pinned.name}' has other bytes`;
}
