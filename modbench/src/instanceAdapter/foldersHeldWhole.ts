import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isRepository } from './files';
import { git, gitFed } from './git';

const PROBE = '.modbench-probe';
const NONE_IGNORED = 1;

const isInside = (instanceRoot: string, folder: string): boolean => {
  const inInstance = relative(instanceRoot, folder);
  return inInstance !== '' && inInstance !== '..' && !inInstance.startsWith(`..${sep}`) && !isAbsolute(inInstance);
};

/** `folder`'s path in the instance repository. */
export const gitPath = (instanceRoot: string, folder: string): string => relative(instanceRoot, folder).split(sep).join('/');

export const splitNul = (output: string): string[] => output.split('\0').filter((path) => path !== '');

async function runsThroughSymlink(instanceRoot: string, folder: string): Promise<boolean> {
  let walked = instanceRoot;
  for (const part of relative(instanceRoot, folder).split(sep)) {
    walked = join(walked, part);
    try {
      if ((await lstat(walked)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function ignoredProbesAmong(instanceRoot: string, probes: readonly string[]): Promise<ReadonlySet<string>> {
  try {
    const answer = await gitFed(instanceRoot, `${probes.join('\0')}\0`, 'check-ignore', '--no-index', '--stdin', '-z');
    return new Set(splitNul(answer));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === NONE_IGNORED) return new Set();
    throw error;
  }
}

async function listIgnoredPaths(instanceRoot: string): Promise<string[]> {
  return splitNul(await git(instanceRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'));
}

/** Each of `folders` the instance repository can hold a file in: inside the instance, and reached through no symlink. */
export async function foldersInReach(instanceRoot: string, folders: readonly string[]): Promise<string[]> {
  const reachable: string[] = [];
  for (const folder of folders) {
    if (isInside(instanceRoot, folder) && !await runsThroughSymlink(instanceRoot, folder)) reachable.push(folder);
  }
  return reachable;
}

export async function foldersHeldWhole(instanceRoot: string, folders: readonly string[]): Promise<ReadonlySet<string>> {
  if (!await isRepository(instanceRoot)) return new Set();
  const reachable = await foldersInReach(instanceRoot, folders);
  if (reachable.length === 0) return new Set();
  const probesOf = (folder: string): string[] => {
    const inFolder = gitPath(instanceRoot, folder);
    return [`${inFolder}/${PROBE}`, `${inFolder}/${PROBE}/${PROBE}`];
  };
  const ignoredProbes = await ignoredProbesAmong(instanceRoot, reachable.flatMap(probesOf));
  const ignoredPaths = await listIgnoredPaths(instanceRoot);
  const ignoresNewFile = (folder: string): boolean => probesOf(folder).some((probe) => ignoredProbes.has(probe));
  const holdsIgnoredFile = (folder: string): boolean => {
    const prefix = `${gitPath(instanceRoot, folder)}/`;
    return ignoredPaths.some((path) => path.startsWith(prefix) || prefix.startsWith(path.endsWith('/') ? path : `${path}/`));
  };
  return new Set(reachable.filter((folder) => !ignoresNewFile(folder) && !holdsIgnoredFile(folder)));
}
