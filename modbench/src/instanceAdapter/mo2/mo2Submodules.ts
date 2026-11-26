// A source mod with a remote is a submodule of the instance repository; git decides the config and the staging.

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gitPath } from '../foldersHeldWhole';
import { errnoCode } from '../../ports/errno';
import { git } from '../git';
import { keptByIndex } from '../keptByIndex';
import { errorMessage } from '../../ports/errorMessage';
import { exists, get, ignoreSkippedLink, isRepository, listDirByStamp, listFolders, putIfChanged, putIfChangedUntold, readOrAbsent, remove, stampKept, textByStamp } from '../files';
import type { InstanceAdapter, SourceHost, Submodule, SubmoduleLacks, SubmoduleNote, UnclonedSubmodule } from '../instanceAdapter';
import {
  ignoreListFile, modsDir, sourceModLinesOf, sourceModPath, sourceRootDir, submodulesFile, leavesOutSourceFolders, withHeldWholeFollowed, withSourceModLines, type SourceFolders,
} from './layout';
import type { FileProblems } from '../../ports/fileProblems';
import type { Mo2Context } from './mo2Context';
import { PRE_PUSH_HOOK, PRE_PUSH_HOOK_NAME } from '../prePushHook';
import { toldAfter } from '../../repositoriesLib/writesTold';
import { sourceFoldersTracked } from './sourceModFolders';
import { hostOf } from './remoteHost';

type Mo2Submodules = Pick<InstanceAdapter, 'writeSubmodules' | 'writeSourceModLines' | 'followFoldersInRepository' | 'sourceHost' | 'submodule' | 'unclonedSubmodules' | 'refuseUnpublishedPins' | 'checkPushRefusalFree' | 'removeRepository' | 'repositoryOnDisk' | 'sourceFolderTracked'>;

interface SubmoduleEntry { readonly name: string; readonly url: string; readonly branch: string }

// Why a source mod's entry is not written, and whether the entry it has stays.
interface EntryNote { readonly note: string; readonly keepsEntry: boolean }

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

const submodulePathsIn = stampKept(async (file: string): Promise<ReadonlyMap<string, string>> => {
  const listed = await git(dirname(file), 'config', '-f', file, '--null', '--list');
  return new Map(listed.split('\0').filter((entry) => entry !== '').flatMap((entry) => {
    const [key = '', value = ''] = entry.split('\n');
    return key.startsWith('submodule.') && key.endsWith('.path') ? [[key.slice('submodule.'.length, -'.path'.length), value] as const] : [];
  }));
});

const submodulePaths = (file: string): Promise<ReadonlyMap<string, string>> => readOrAbsent(() => submodulePathsIn(file), new Map());

async function sourceEntries(file: string): Promise<string[]> {
  return [...await submodulePaths(file)].flatMap(([name, path]) => (path.startsWith(sourceModPath('')) ? [name] : []));
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

/** The source folders a clone gets: those `.gitmodules` names, or `submodules`, and each other that holds no repository of its own. */
export async function sourceFoldersOf(instanceRoot: string, submodules?: ReadonlySet<string>): Promise<SourceFolders> {
  const entries = submodules ?? new Set(await sourceEntries(submodulesFile(instanceRoot)));
  const folders = await readOrAbsent(() => listFolders(sourceRootDir(instanceRoot), ignoreSkippedLink, listDirByStamp), []);
  const plain: string[] = [];
  for (const name of folders) if (!entries.has(name) && !(await isRepository(join(sourceRootDir(instanceRoot), name)))) plain.push(name);
  return { submodules: [...entries], plain };
}

async function sourceModLinesWritten(instanceRoot: string, submodules?: ReadonlySet<string>, letIn: readonly string[] = []): Promise<void> {
  const file = ignoreListFile(instanceRoot);
  if (!(await exists(file))) return;
  const onDisk = await sourceFoldersOf(instanceRoot, submodules);
  const folders = { ...onDisk, plain: [...new Set([...onDisk.plain, ...letIn.filter((name) => !onDisk.submodules.includes(name))])] };
  await putIfChangedUntold(file, (before) => {
    const after = withSourceModLines(before, folders);
    if (after === undefined) throw new Error(`${file} has a source folders marker with no match, so its source folder lines are left as they are`);
    return after;
  });
}

/** Rewrites the source folder lines when the source folders change, in an ignore list that holds the whitelist. A marker
 *  with no match shows as a problem on it. Run on each reading of the instance. */
export function sourceModLinesFollowed(instanceRoot: string, problems: FileProblems): () => Promise<void> {
  const file = ignoreListFile(instanceRoot);
  let followed: string | undefined;
  let shown = false;
  return async () => {
    if (!(await isRepository(instanceRoot)) || !leavesOutSourceFolders(await readOrAbsent(() => textByStamp(file), ''))) return;
    const folders = await sourceFoldersOf(instanceRoot);
    const now = JSON.stringify(folders);
    if (now === followed) return;
    try {
      await sourceModLinesWritten(instanceRoot, new Set(folders.submodules));
      followed = now;
      if (shown) problems.set(file, []);
      shown = false;
    } catch (err) {
      problems.set(file, [{ line: 1, message: errorMessage(err) }]);
      shown = true;
    }
  };
}

// A hook outside the repository's own git directory would run in every repository that reads it.
async function hooksFolder({ instanceRoot, repository: reads }: Mo2Context): Promise<string> {
  const repository = await isRepository(instanceRoot);
  const gitDir = repository ? resolve(instanceRoot, await reads.git('rev-parse', '--git-common-dir')) : join(instanceRoot, '.git');
  const configuredHooks = await reads.git('config', '--type=path', '--get', 'core.hooksPath');
  const hooks = configuredHooks !== '' ? resolve(instanceRoot, configuredHooks)
    : repository ? resolve(instanceRoot, await reads.git('rev-parse', '--git-path', 'hooks')) : join(gitDir, 'hooks');
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

interface Written { readonly entries: ReadonlyMap<string, string>; readonly ignoreList: string }

// Each submodule's lines in `.gitmodules` by its name, and the ignore list: what a call to writeSubmodules can write.
async function writtenState(instanceRoot: string): Promise<Written> {
  const file = submodulesFile(instanceRoot);
  const entries = new Map<string, string>();
  if (await exists(file)) {
    const listed = await git(instanceRoot, 'config', '-f', file, '--null', '--list');
    for (const entry of listed.split('\0').filter((each) => each !== '')) {
      const key = entry.split('\n')[0] ?? '';
      if (!key.startsWith('submodule.')) continue;
      const name = key.slice('submodule.'.length, key.lastIndexOf('.'));
      entries.set(name, `${entries.get(name) ?? ''}${entry}\n`);
    }
  }
  return { entries, ignoreList: await get(ignoreListFile(instanceRoot), '') };
}

// The index holds a submodule's pin as a gitlink, mode 160000.
async function submoduleIn(instanceRoot: string, name: string): Promise<Submodule | SubmoduleLacks> {
  const file = submodulesFile(instanceRoot);
  const path = await configured(instanceRoot, file, `submodule.${name}.path`);
  if (path === '') return { lacks: `${file} names no submodule '${name}'` };
  const [mode, pin] = (await git(instanceRoot, 'ls-files', '--stage', '--', path)).split(/\s/);
  if (mode !== '160000' || pin === undefined) return { lacks: `the instance repository pins no commit at ${path}`, unpinned: true };
  const branch = await configured(instanceRoot, file, `submodule.${name}.branch`);
  return { folder: resolve(instanceRoot, path), pin, ...(branch === '' ? {} : { branch }) };
}

const isOwnHook = (hook: string): Promise<boolean> => textByStamp(hook).then((text) => text === PRE_PUSH_HOOK, () => false);

/** Whether the repository holds Modbench's pre-push hook, in the place `refuseUnpublishedPins` writes it, which the watch
 *  follows. */
export const pushRefusalWritten = (context: Mo2Context): Promise<boolean> =>
  hooksFolder(context).then((hooks) => {
    context.watch.follow('pushCheck', [hooks], PRE_PUSH_HOOK_NAME);
    return isOwnHook(join(hooks, PRE_PUSH_HOOK_NAME));
  }, () => false);

const keptSubmodules = keptByIndex<Awaited<ReturnType<typeof submoduleIn>>>();

export function mo2Submodules(context: Mo2Context): Mo2Submodules {
  const { instanceRoot } = context;
  return {
    async writeSubmodules(acted, sourceMods) {
      if (!(await isRepository(instanceRoot))) return { notes: [], other: [], written: [] };
      const file = submodulesFile(instanceRoot);
      const built = new Set([...sourceMods.values()].map((folder) => basename(folder)));
      const notes: SubmoduleNote[] = [];
      const other: string[] = [];
      let before: Written | undefined;
      try {
        before = await writtenState(instanceRoot);
      } catch (err) {
        other.push(`which source mods it wrote could not be read, so none is named: ${errorMessage(err)}`);
      }
      const kept = new Set<string>();
      let existing: string[] = [];
      try {
        existing = await sourceEntries(file);
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
      const written: string[] = [];
      if (before !== undefined) {
        try {
          const after = await writtenState(instanceRoot);
          for (const [mod, folder] of sourceMods) {
            const name = basename(folder);
            const entryChanged = before.entries.get(name) !== after.entries.get(name);
            const linesChanged = sourceModLinesOf(before.ignoreList, name).join() !== sourceModLinesOf(after.ignoreList, name).join();
            if (entryChanged || linesChanged) written.push(mod);
          }
        } catch (err) {
          other.push(`which source mods it wrote could not be read, so none is named: ${errorMessage(err)}`);
        }
      }
      return { notes, other, written };
    },

    async writeSourceModLines(letIn) {
      if (await isRepository(instanceRoot)) await sourceModLinesWritten(instanceRoot, undefined, letIn);
    },

    async followFoldersInRepository(moves) {
      if (!(await isRepository(instanceRoot))) return;
      const list = ignoreListFile(instanceRoot);
      const heldWhole = moves.filter(({ from }) => dirname(from) === modsDir(instanceRoot));
      if (heldWhole.length > 0 && await exists(list)) {
        await putIfChanged(list, (before) => heldWhole.reduce((text, { from, to }) => {
          const after = withHeldWholeFollowed(text, basename(from), basename(to));
          if (after === undefined) throw new Error(`${list} has a marker of the mod folders held whole with no match, so their lines are left as they are`);
          return after;
        }, before));
      }
      const file = submodulesFile(instanceRoot);
      const paths = await submodulePaths(file);
      for (const { from, to } of moves) {
        const [name] = [...paths].find(([, path]) => path === gitPath(instanceRoot, from)) ?? [];
        if (name === undefined) continue;
        if (name !== basename(to)) await git(instanceRoot, 'config', '-f', file, '--rename-section', `submodule.${name}`, `submodule.${basename(to)}`);
        await git(instanceRoot, 'config', '-f', file, `submodule.${basename(to)}.path`, gitPath(instanceRoot, to));
      }
    },

    sourceHost: (folder) => sourceHostOf(folder).then(
      (answer) => ({ kind: 'read' as const, answer }), (err: unknown) => ({ kind: 'unreadable' as const, reason: errorMessage(err) })),

    submodule: (name) => keptSubmodules(instanceRoot, name, () => submoduleIn(instanceRoot, name)).catch((err: unknown) =>
      ({ lacks: `the instance repository's submodule '${name}' could not be read: ${errorMessage(err)}` })),

    async unclonedSubmodules() {
      if (!(await isRepository(instanceRoot))) return [];
      const uncloned: UnclonedSubmodule[] = [];
      for (const name of await sourceEntries(submodulesFile(instanceRoot))) {
        if (await isRepository(join(sourceRootDir(instanceRoot), name))) continue;
        uncloned.push({ name, ...await keptSubmodules(instanceRoot, name, () => submoduleIn(instanceRoot, name)) });
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
      const hook = join(await hooksFolder(context), PRE_PUSH_HOOK_NAME);
      if (await exists(hook)) throw hookExists(hook);
    },

    async refuseUnpublishedPins() {
      const hooks = await hooksFolder(context);
      await mkdir(hooks, { recursive: true });
      const hook = join(hooks, PRE_PUSH_HOOK_NAME);
      let written = true;
      await toldAfter([hook], () => writeFile(hook, PRE_PUSH_HOOK, { mode: 0o755, flag: 'wx' })).catch(async (err: unknown) => {
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
