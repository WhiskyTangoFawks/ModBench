// What a FOMOD's release says of itself in its info file: the header's fields.

import { join } from 'node:path';
import { releaseXmlText } from './releaseXml';
import { keyOf } from './releasePaths';
import { xmlText } from './xmlText';

export interface About {
  readonly author: string;
  readonly version: string;
  readonly website: string;
}

export const NO_ABOUT: About = { author: '', version: '', website: '' };

const INFO = 'fomod/info.xml';

const fieldOf = (text: string, tag: string): string =>
  xmlText(new RegExp(String.raw`<${tag}\b[^>]*>([\s\S]*?)</${tag}>`, 'i').exec(text)?.[1] ?? '').trim();

/** The author, version and website of the release's info file, each empty when the file or the field is missing. */
export async function aboutIn(root: string, files: readonly string[]): Promise<About> {
  const info = files.find((file) => keyOf(file) === INFO);
  const text = info === undefined ? undefined : await releaseXmlText(join(root, info));
  if (text === undefined) return NO_ABOUT;
  return { author: fieldOf(text, 'Author'), version: fieldOf(text, 'Version'), website: fieldOf(text, 'Website') };
}
