import { posix, win32 } from 'node:path';

/** Whether two paths name one file as the platform matches them: Windows without case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = (p: string): string => (platform === 'win32' ? win32.normalize(p).toLowerCase() : posix.normalize(p));
  return key(a) === key(b);
}
