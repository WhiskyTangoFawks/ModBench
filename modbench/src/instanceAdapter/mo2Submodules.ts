// A source mod with a remote is a submodule of the instance repository; git decides the config and the staging.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../ports/errorMessage';
import { exists, get, isRepository, write } from './files';
import type { InstanceAdapter, SubmoduleNote } from './instanceAdapter';
import { ignoreListFile, sourceModPath, submodulesFile, withSourceModLines } from './layout';
import type { Mo2Context } from './mo2Context';
import { sourceModsIn } from './sourceMods';

type Mo2Submodules = Pick<InstanceAdapter, 'writeSubmodules' | 'refuseUnpublishedPins'>;

const execFileAsync = promisify(execFile);

const git = async (folder: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-C', folder, ...args], { encoding: 'utf8' })).stdout;

interface Submodule { readonly name: string; readonly url: string; readonly branch: string }

async function submoduleOf(folder: string): Promise<Submodule | undefined | string> {
  try {
    const remotes = (await git(folder, 'remote')).split('\n').filter((remote) => remote !== '');
    if (remotes.length === 0) return undefined;
    const url = (await git(folder, 'remote', 'get-url', remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin')).trim();
    const branch = (await git(folder, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim();
    return branch === '' ? 'it has a remote but no branch checked out, so it is not a submodule' : { name: basename(folder), url, branch };
  } catch (err) {
    return `its remote could not be read, so it is not a submodule: ${errorMessage(err)}`;
  }
}

// git config exits 1 when nothing matches.
async function sourceEntries(instanceRoot: string, file: string): Promise<string[]> {
  if (!(await exists(file))) return [];
  const listed = await git(instanceRoot, 'config', '-f', file, '--null', '--get-regexp', String.raw`^submodule\..*\.path$`)
    .catch((err: unknown) => {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 1) return '';
      throw err;
    });
  return listed.split('\0').filter((entry) => entry !== '')
    .flatMap((entry) => {
      const [key = '', path = ''] = entry.split('\n');
      return path.startsWith(sourceModPath('')) ? [key.slice('submodule.'.length, -'.path'.length)] : [];
    });
}

export function mo2Submodules({ instanceRoot }: Mo2Context): Mo2Submodules {
  return {
    async writeSubmodules() {
      if (!(await isRepository(instanceRoot))) return [];
      const file = submodulesFile(instanceRoot);
      const notes: SubmoduleNote[] = [];
      const wanted: Submodule[] = [];
      for (const [mod, folder] of (await sourceModsIn(instanceRoot)).folders) {
        const found = await submoduleOf(folder);
        if (typeof found === 'string') notes.push({ mod, note: found });
        else if (found !== undefined) wanted.push(found);
      }
      const names = new Set(wanted.map(({ name }) => name));
      for (const name of await sourceEntries(instanceRoot, file)) {
        if (!names.has(name)) await git(instanceRoot, 'config', '-f', file, '--remove-section', `submodule.${name}`);
      }
      for (const { name, url, branch } of wanted) {
        await git(instanceRoot, 'config', '-f', file, `submodule.${name}.path`, sourceModPath(name));
        await git(instanceRoot, 'config', '-f', file, `submodule.${name}.url`, url);
        await git(instanceRoot, 'config', '-f', file, `submodule.${name}.branch`, branch);
      }
      const ignoreFile = ignoreListFile(instanceRoot);
      if (await exists(ignoreFile)) {
        const before = await get(ignoreFile);
        const after = withSourceModLines(before, [...names]);
        if (after !== before) await write(ignoreFile, after);
      }
      return notes;
    },

    async refuseUnpublishedPins() {
      await git(instanceRoot, 'config', 'push.recurseSubmodules', 'check');
    },
  };
}
