// A FOMOD's paths, as the reference installer compares them: either slash, any case.

import { posix } from 'node:path';

export const keyOf = (path: string): string => path.replaceAll('\\', '/').toLowerCase();

/** A path as the release spells the file it names; none when it names none, as a path out of the release does. The
 *  engine gives no path for an image the FOMOD omits. */
export function resolverIn(files: readonly string[]): (path: string | null | undefined) => string | undefined {
  const spelled = new Map(files.map((file) => [keyOf(file), file]));
  return (path) => spelled.get(posix.normalize(keyOf(path ?? '')));
}
