import { dirname, join } from 'node:path';
import { errnoCode } from '../ports/errno';
import { GIT_DIR, listDirByStamp, settledBefore, stampOf } from './files';

const IGNORE_FILE = '.gitignore';

interface Stamped {
  readonly text: string;
  readonly settled: boolean;
}

async function stampText(path: string): Promise<Stamped> {
  const stamp = await stampOf(path);
  return { text: `${path}|${stamp.size}|${stamp.modifiedNs}|${stamp.changedNs}`, settled: settledBefore(stamp, Date.now()) };
}

async function stampsUnder(folder: string): Promise<Stamped[]> {
  const entries = await listDirByStamp(folder);
  const below = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) return entry.name === GIT_DIR ? [] : stampsUnder(join(folder, entry.name));
    return entry.name === IGNORE_FILE ? [await stampText(join(folder, entry.name))] : [];
  }));
  return [await stampText(folder), ...below.flat()];
}

function ancestorsOf(root: string, folders: readonly string[]): string[] {
  const above = new Set<string>();
  for (const folder of folders) {
    for (let up = dirname(folder); up.startsWith(root) && up !== dirname(up); up = dirname(up)) above.add(up);
  }
  return [...above];
}

const ignoreFileAbove = (above: string): Promise<Stamped> =>
  stampText(join(above, IGNORE_FILE)).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return { text: `${above}|absent`, settled: true };
    throw err;
  });

/** What git's listing of `folders` depends on besides its state: the stamps of their folders and ignore files, and of the
 *  ignore files above them down from `root`. Undefined while one is younger than two seconds. */
export async function treeStampsOf(root: string, folders: readonly string[]): Promise<string | undefined> {
  try {
    const stamps = [
      ...(await Promise.all(folders.map(stampsUnder))).flat(),
      ...await Promise.all(ancestorsOf(root, folders).map(ignoreFileAbove)),
    ];
    return stamps.every(({ settled }) => settled) ? stamps.map(({ text }) => text).join('\n') : undefined;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return undefined;
    throw err;
  }
}
