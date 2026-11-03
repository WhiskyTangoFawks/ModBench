import { isAbsolute, relative, sep } from 'node:path';
import { isRepository } from './files';
import { git, gitFed } from './git';

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
    if (error instanceof Error && 'code' in error && error.code === NONE_IGNORED) return new Set();
    throw error;
  }
}

async function ignoredPathsHeld(instanceRoot: string): Promise<string[]> {
  const listed = await git(instanceRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  return listed.split('\0').filter((path) => path !== '');
}

/** Held whole: a new file at either depth would not be ignored (the rules), and no file the folder holds is ignored. */
export async function foldersHeldWhole(instanceRoot: string, folders: readonly string[]): Promise<ReadonlySet<string>> {
  if (!await isRepository(instanceRoot)) return new Set();
  const inside = folders.filter((folder) => isInside(instanceRoot, folder));
  if (inside.length === 0) return new Set();
  const ignoredProbes = await ignoredAmong(instanceRoot, inside.flatMap((folder) => probesIn(instanceRoot, folder)));
  const ignoredFiles = await ignoredPathsHeld(instanceRoot);
  const holdsIgnoredFile = (folder: string): boolean => {
    const prefix = `${relative(instanceRoot, folder).split(sep).join('/')}/`;
    return ignoredFiles.some((path) => path.startsWith(prefix) || prefix.startsWith(path.endsWith('/') ? path : `${path}/`));
  };
  return new Set(inside.filter((folder) => probesIn(instanceRoot, folder).every((probe) => !ignoredProbes.has(probe)) && !holdsIgnoredFile(folder)));
}
