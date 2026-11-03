// A source mod with a remote is a submodule of the instance repository; git decides the config and the staging.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { git } from '../git';
import { errorMessage } from '../../ports/errorMessage';
import { exists, ignoreSkippedLink, isRepository, listFolders, putIfChanged, readOrAbsent, remove } from '../files';
import type { InstanceAdapter, SourceHost, Submodule, SubmoduleNote, UnclonedSubmodule } from '../instanceAdapter';
import { ignoreListFile, sourceModPath, sourceRootDir, submodulesFile, withSourceModLines, type SourceRepositories } from './layout';
import type { Mo2Context } from './mo2Context';
import { PRE_PUSH_HOOK, PRE_PUSH_HOOK_NAME } from '../prePushHook';
import { sourceFoldersTracked } from './sourceModFolders';

type Mo2Submodules = Pick<InstanceAdapter, 'writeSubmodules' | 'writeSourceModLines' | 'sourceHost' | 'submodule' | 'unclonedSubmodules' | 'refuseUnpublishedPins' | 'checkPushRefusalFree' | 'removeRepository' | 'repositoryOnDisk' | 'sourceFolderTracked'>;

interface SubmoduleEntry { readonly name: string; readonly url: string; readonly branch: string }

// Why a source mod's entry is not written, and whether the entry it has stays.
interface EntryNote { readonly note: string; readonly keepsEntry: boolean }

const UNSAFE = 'its remote holds a credential that cannot safely be left out of its URL';

// instance-repository.md, The repository, story 3: a path or a file URL reaches no other machine.
const LOCAL = 'its remote is on this machine alone';

// git's scp-like form, [user@]host:path, whose host is longer than a Windows drive letter, and that form with a password.
const SCP_LIKE = /^([^/\\@:]+@)?[^/\\@:]{2,}:/;
const SCP_PASSWORD = /^[^/\\@:]{2,}:[^/\\]*@/;

// An HTTP user is a credential; another scheme's user names the account, so only its password goes.
const accountOf = (scheme: string, userInfo: string): string => {
  const [user = ''] = userInfo.split(':');
  return user === '' || /^https?$/i.test(scheme) ? '' : `${user}@`;
};

function scpLikeHost(url: string): SourceHost {
  if (SCP_PASSWORD.test(url)) return { kind: 'noHost', why: UNSAFE };
  return SCP_LIKE.test(url) ? { kind: 'host', url } : { kind: 'noHost', why: LOCAL };
}

function hostOf(url: string): SourceHost {
  const [, scheme, authority = '', path = ''] = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(url) ?? [];
  if (scheme === undefined) return scpLikeHost(url);
  if (scheme.toLowerCase() === 'file') return { kind: 'noHost', why: LOCAL };
  const [userInfo = '', host, ...more] = authority.split('@');
  if (host === undefined) return { kind: 'host', url };
  return more.length > 0 || host === '' ? { kind: 'noHost', why: UNSAFE } : { kind: 'host', url: `${scheme}://${accountOf(scheme, userInfo)}${host}${path}` };
}

// git lists remotes by name.
async function sourceHostOf(folder: string): Promise<SourceHost> {
  const remotes = (await git(folder, 'remote')).split('\n').filter((remote) => remote !== '');
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return remote === undefined ? { kind: 'noRemote' } : hostOf((await git(folder, 'remote', 'get-url', remote)).trim());
}

async function submoduleOf(folder: string): Promise<SubmoduleEntry | undefined | EntryNote> {
  try {
    const host = await sourceHostOf(folder);
    if (host.kind === 'noRemote') return undefined;
    if (host.kind === 'noHost') return { note: `${host.why}, so it is no submodule`, keepsEntry: false };
    const branch = (await git(folder, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim();
    return branch === '' ? { note: 'it has a remote but no branch checked out, so its entry stays as it was', keepsEntry: true } : { name: basename(folder), url: host.url, branch };
  } catch (err) {
    return { note: `its remote could not be read, so its entry stays as it was: ${errorMessage(err)}`, keepsEntry: true };
  }
}

async function sourceEntries(instanceRoot: string, file: string): Promise<string[]> {
  if (!(await exists(file))) return [];
  const listed = await git(instanceRoot, 'config', '-f', file, '--null', '--list');
  return listed.split('\0').filter((entry) => entry !== '').flatMap((entry) => {
    const [key = '', value = ''] = entry.split('\n');
    return key.startsWith('submodule.') && key.endsWith('.path') && value.startsWith(sourceModPath(''))
      ? [key.slice('submodule.'.length, -'.path'.length)] : [];
  });
}

// An unset key is exit code 5.
async function entryRemoved(instanceRoot: string, file: string, name: string): Promise<void> {
  for (const key of ['path', 'url', 'branch']) {
    await git(instanceRoot, 'config', '-f', file, '--unset-all', `submodule.${name}.${key}`).catch((err: unknown) => {
      if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 5) throw err;
    });
  }
}

async function entryWritten(instanceRoot: string, file: string, { name, url, branch }: SubmoduleEntry): Promise<void> {
  await git(instanceRoot, 'config', '-f', file, `submodule.${name}.path`, sourceModPath(name));
  await git(instanceRoot, 'config', '-f', file, `submodule.${name}.url`, url);
  await git(instanceRoot, 'config', '-f', file, `submodule.${name}.branch`, branch);
}

/** The source folders that hold a repository of their own: those `.gitmodules` names, or `submodules`, and the rest. */
export async function sourceRepositoriesOf(instanceRoot: string, submodules?: ReadonlySet<string>): Promise<SourceRepositories> {
  const entries = submodules ?? new Set(await sourceEntries(instanceRoot, submodulesFile(instanceRoot)));
  const folders = await readOrAbsent(() => listFolders(sourceRootDir(instanceRoot), ignoreSkippedLink), []);
  const withoutEntry: string[] = [];
  for (const name of folders) if (!entries.has(name) && await isRepository(join(sourceRootDir(instanceRoot), name))) withoutEntry.push(name);
  return { submodules: [...entries], withoutEntry };
}

async function sourceModLinesWritten(instanceRoot: string, submodules?: ReadonlySet<string>): Promise<void> {
  const file = ignoreListFile(instanceRoot);
  if (!(await exists(file))) return;
  const repositories = await sourceRepositoriesOf(instanceRoot, submodules);
  await putIfChanged(file, (before) => {
    const after = withSourceModLines(before, repositories);
    if (after === undefined) throw new Error(`${file} has a source mods marker with no match, so its source mod lines are left as they are`);
    return after;
  });
}

// A hook outside the repository's own git directory would run in every repository that reads it.
async function hooksFolder(instanceRoot: string): Promise<string> {
  const repository = await isRepository(instanceRoot);
  const gitDir = repository ? resolve(instanceRoot, (await git(instanceRoot, 'rev-parse', '--git-common-dir')).trim()) : join(instanceRoot, '.git');
  const configuredHooks = (await git(instanceRoot, 'config', '--type=path', '--get', 'core.hooksPath').catch((err: unknown) => {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 1) return '';
    throw err;
  })).trim();
  const hooks = configuredHooks !== '' ? resolve(instanceRoot, configuredHooks)
    : repository ? resolve(instanceRoot, (await git(instanceRoot, 'rev-parse', '--git-path', 'hooks')).trim()) : join(gitDir, 'hooks');
  if (relative(gitDir, hooks).startsWith('..') || isAbsolute(relative(gitDir, hooks))) {
    throw new Error(`core.hooksPath points to ${hooks}, outside ${gitDir}, where a hook would run in every repository that reads it; Modbench writes no hook there.`);
  }
  return hooks;
}

const hookExists = (hook: string): Error => new Error(`${hook} already exists; Modbench does not write over it.`);

// git config --get exits 1 for a key that is not set.
const configured = (instanceRoot: string, file: string, key: string): Promise<string> =>
  git(instanceRoot, 'config', '-f', file, '--get', key).then((value) => value.trim(), (err: unknown) => {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 1) return '';
    throw err;
  });

// The index holds a submodule's pin as a gitlink, mode 160000.
async function submoduleIn(instanceRoot: string, name: string): Promise<Submodule | { readonly lacks: string }> {
  const file = submodulesFile(instanceRoot);
  const path = await configured(instanceRoot, file, `submodule.${name}.path`);
  if (path === '') return { lacks: `${file} names no submodule '${name}'` };
  const [mode, pin] = (await git(instanceRoot, 'ls-files', '--stage', '--', path)).split(/\s/);
  if (mode !== '160000' || pin === undefined) return { lacks: `the instance repository pins no commit at ${path}` };
  const branch = await configured(instanceRoot, file, `submodule.${name}.branch`);
  return { folder: resolve(instanceRoot, path), pin, ...(branch === '' ? {} : { branch }) };
}

const isOwnHook = (hook: string): Promise<boolean> => readFile(hook, 'utf8').then((text) => text === PRE_PUSH_HOOK, () => false);

/** Whether the repository holds Modbench's pre-push hook, in the place `refuseUnpublishedPins` writes it. */
export const pushRefusalWritten = (instanceRoot: string): Promise<boolean> =>
  hooksFolder(instanceRoot).then((hooks) => isOwnHook(join(hooks, PRE_PUSH_HOOK_NAME)), () => false);

export function mo2Submodules({ instanceRoot }: Mo2Context): Mo2Submodules {
  return {
    async writeSubmodules(acted, sourceMods) {
      if (!(await isRepository(instanceRoot))) return { notes: [], other: [] };
      const file = submodulesFile(instanceRoot);
      const built = new Set([...sourceMods.values()].map((folder) => basename(folder)));
      const notes: SubmoduleNote[] = [];
      const other: string[] = [];
      const kept = new Set<string>();
      let existing: string[] = [];
      try {
        existing = await sourceEntries(instanceRoot, file);
      } catch (err) {
        other.push(`${file} could not be read, so no source mod's entry is changed: ${errorMessage(err)}`);
      }
      for (const [mod, folder] of sourceMods) {
        // ADR-0022
        if ((acted !== 'every' && !acted.includes(mod)) || !(await isRepository(folder))) continue;
        const found = await submoduleOf(folder);
        const name = basename(folder);
        if (found !== undefined && 'note' in found) {
          notes.push({ mod, note: found.note });
          if (found.keepsEntry && existing.includes(name)) kept.add(name);
        } else if (found !== undefined) {
          kept.add(name);
          try {
            await entryWritten(instanceRoot, file, found);
          } catch (err) {
            notes.push({ mod, note: `its entry could not be written: ${errorMessage(err)}` });
          }
        }
      }
      for (const name of existing) {
        if (kept.has(name)) continue;
        if (acted !== 'every') {
          kept.add(name);
          continue;
        }
        if (!built.has(name) && await isRepository(join(sourceRootDir(instanceRoot), name))) {
          kept.add(name);
          continue;
        }
        try {
          await entryRemoved(instanceRoot, file, name);
        } catch (err) {
          other.push(`the entry of source/${name} could not be removed from ${file}: ${errorMessage(err)}`);
        }
      }
      try {
        await sourceModLinesWritten(instanceRoot, kept);
      } catch (err) {
        other.push(errorMessage(err));
      }
      return { notes, other };
    },

    async writeSourceModLines() {
      if (await isRepository(instanceRoot)) await sourceModLinesWritten(instanceRoot);
    },

    sourceHost: (folder) => sourceHostOf(folder).then(
      (answer) => ({ kind: 'read' as const, answer }), (err: unknown) => ({ kind: 'unreadable' as const, reason: errorMessage(err) })),

    submodule: (name) => submoduleIn(instanceRoot, name).catch((err: unknown) =>
      ({ lacks: `the instance repository's submodule '${name}' could not be read: ${errorMessage(err)}` })),

    async unclonedSubmodules() {
      if (!(await isRepository(instanceRoot))) return [];
      const uncloned: UnclonedSubmodule[] = [];
      for (const name of await sourceEntries(instanceRoot, submodulesFile(instanceRoot))) {
        if (await isRepository(join(sourceRootDir(instanceRoot), name))) continue;
        uncloned.push({ name, ...await submoduleIn(instanceRoot, name) });
      }
      return uncloned;
    },

    repositoryOnDisk: () => isRepository(instanceRoot),

    sourceFolderTracked: async (name) => (await sourceFoldersTracked(instanceRoot, [name])).has(name),

    async removeRepository() {
      if (!(await isRepository(instanceRoot))) return;
      const holdsRefs = (await git(instanceRoot, 'for-each-ref')).trim() !== '';
      const holdsHead = await git(instanceRoot, 'rev-parse', '--verify', '-q', 'HEAD').then(() => true, () => false);
      if (holdsRefs || holdsHead) throw new Error(`${join(instanceRoot, '.git')} holds commits or refs that git init did not make, so it is kept.`);
      await remove(join(instanceRoot, '.git'));
    },

    async checkPushRefusalFree() {
      const hook = join(await hooksFolder(instanceRoot), PRE_PUSH_HOOK_NAME);
      if (await exists(hook)) throw hookExists(hook);
    },

    async refuseUnpublishedPins() {
      const hooks = await hooksFolder(instanceRoot);
      await mkdir(hooks, { recursive: true });
      const hook = join(hooks, PRE_PUSH_HOOK_NAME);
      let written = true;
      await writeFile(hook, PRE_PUSH_HOOK, { mode: 0o755, flag: 'wx' }).catch(async (err: unknown) => {
        if (errnoCode(err) !== 'EEXIST') throw err;
        if (!(await isOwnHook(hook))) throw hookExists(hook);
        written = false;
      });
      return async () => {
        if (written && await isOwnHook(hook)) await remove(hook);
      };
    },
  };
}
