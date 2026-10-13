import { posix, win32 } from 'node:path';

/** Whether two paths name one file as the platform matches them: Windows without case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = platform === 'win32' ? (p: string) => win32.normalize(p).toLowerCase() : posix.normalize;
  return key(a) === key(b);
}
