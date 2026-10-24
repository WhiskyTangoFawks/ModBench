// What a FOMOD's release says of itself, read from its files: the header's fields, and the images it names.

import { join, posix } from 'node:path';
import { textIfUtf8 } from '../files';

export interface About {
  readonly author: string;
  readonly version: string;
  readonly website: string;
}

export const NO_ABOUT: About = { author: '', version: '', website: '' };

/** A path compared as Windows compares it, so a FOMOD written there finds its files and merges its folders. */
export const keyOf = (path: string): string => path.replaceAll('\\', '/').toLowerCase();

const INFO = 'fomod/info.xml';

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

const fieldOf = (text: string, tag: string): string => {
  const found = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, 'i').exec(text)?.[1] ?? '';
  return found.replace(/&(amp|lt|gt|quot|apos);/g, (entity, name: string) => ENTITIES[name] ?? entity).trim();
};

/** The author, version and website of the release's info file, each empty when the file or the field is missing. */
export async function aboutIn(root: string, files: readonly string[]): Promise<About> {
  const info = files.find((file) => keyOf(file) === INFO);
  const text = info === undefined ? undefined : await textIfUtf8(join(root, info));
  if (text === undefined) return NO_ABOUT;
  return { author: fieldOf(text, 'Author'), version: fieldOf(text, 'Version'), website: fieldOf(text, 'Website') };
}

/** A path the FOMOD gives, as the release spells the file it names; empty for a path that names no file of the
 *  release, which includes every path that climbs out of it. The engine gives no path for an image the FOMOD omits. */
export function imageResolver(files: readonly string[]): (path: string | null | undefined) => string {
  const spelled = new Map(files.map((file) => [keyOf(file), file]));
  return (path) => spelled.get(posix.normalize(keyOf(path ?? ''))) ?? '';
}
