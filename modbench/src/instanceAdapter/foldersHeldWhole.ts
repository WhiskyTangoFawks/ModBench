import { isAbsolute, relative, sep } from 'node:path';
import { isRepository } from './files';
import { gitFed } from './git';

const PROBE = '.modbench-probe';
const NONE_IGNORED = 1;

const isInside = (instanceRoot: string, folder: string): boolean => {
  const inInstance = relative(instanceRoot, folder);
  return inInstance !== '' && inInstance !== '..' && !inInstance.startsWith(`..${sep}`) && !isAbsolute(inInstance);
};

const probesIn = (instanceRoot: string, folder: string): string[] => {
  const inside = relative(instanceRoot, folder).split(sep).join('/');
  return [`${inside}/${PROBE}`, `${inside}/${PROBE}/${PROBE}`];
};

async function ignoredAmong(instanceRoot: string, probes: readonly string[]): Promise<ReadonlySet<string>> {
  try {
    const answer = await gitFed(instanceRoot, `${probes.join('\0')}\0`, 'check-ignore', '--no-index', '--stdin', '-z');
    return new Set(answer.split('\0').filter((path) => path !== ''));
  } catch (error) {
    if ((error as { code?: unknown }).code === NONE_IGNORED) return new Set();
    throw error;
  }
}

/** Held whole is a property of the ignore rules: a new file at either depth of the folder would not be ignored. */
export async function foldersHeldWhole(instanceRoot: string, folders: readonly string[]): Promise<ReadonlySet<string>> {
  if (!await isRepository(instanceRoot)) return new Set();
  const inside = folders.filter((folder) => isInside(instanceRoot, folder));
  if (inside.length === 0) return new Set();
  const ignored = await ignoredAmong(instanceRoot, inside.flatMap((folder) => probesIn(instanceRoot, folder)));
  return new Set(inside.filter((folder) => probesIn(instanceRoot, folder).every((probe) => !ignored.has(probe))));
}
