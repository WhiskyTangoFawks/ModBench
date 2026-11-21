// What MO2's implementation lets the instance repository hold, and which game files a mod's files take.

import { dirname, join, relative } from 'node:path';
import { commitFolder } from '../commitFolder';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { exists, existsByStamp, get, GIT_DIR, ignoreSkippedLink, listDirByStamp, listFolders, readOrAbsent, listEntries, putIfChanged, remove, type ResolvedEntry } from '../files';
import { ignoreLink, listOwnEntries } from '../gameFolder/ownEntries';
import type { HashIndex } from '../fileContents/hashIndex';
import { isBareName, type DeployedPath, type FileRead, type GameFile, type InstanceAdapter } from '../instanceAdapter';
import { DATA_FOLDER } from '../gameFolder/gameFolderResolver';
import { isWithin } from '../gameFolder/pathWithin';
import {
  hashIndexDir, ignoreListFile, isManifestPath, modsDir, recordIndexDir,
  sortingRuleFilePaths, sourceRootDir, submodulesFile, whitelistIgnoreList, withHeldWholeLines, withSourceModLines,
} from './layout';
import type { ConfigurationFile, ManagerAdapter } from '../publisher';
import type { Mo2Context } from './mo2Context';
import { filesBelow } from './mo2Files';
import { sourceFoldersOf } from './mo2Submodules';

type Mo2Repository = Pick<InstanceAdapter, 'writeIgnoreList' | 'writeHeldWholeLines' | 'commitFolder'> & Pick<ManagerAdapter, 'filesKept'>;

const namesIn = (root: string, folders: readonly string[]): string[] => folders.map((folder) => {
  const name = relative(root, folder);
  if (!isBareName(name)) throw new Error(`${folder} is not a folder of ${root}, so the instance repository's ignore list does not name it`);
  return name;
});

// The lines of folders of `root`, written in the ignore list when the instance has one.
async function folderLinesWritten(
  instanceRoot: string, root: string, folders: readonly string[], kept: string, withLines: (ignoreList: string, names: readonly string[]) => string | undefined,
): Promise<void> {
  const file = ignoreListFile(instanceRoot);
  const names = namesIn(root, folders);
  if (!(await exists(file))) return;
  await putIfChanged(file, (before) => {
    const after = withLines(before, names);
    if (after === undefined) throw new Error(`${file} has a marker of the ${kept} it holds with no match, so their lines are left as they are`);
    return after;
  });
}

const lowerCased = (names: readonly ResolvedEntry[]): Map<string, ResolvedEntry> => new Map(names.map((entry) => [entry.name.toLowerCase(), entry]));

// The game's folder is as case-sensitive as its file system, and a mod's paths are the game's, which ignores case.
function caseBlindFinder(root: string) {
  const listings = new Map<string, Promise<FileRead<Map<string, ResolvedEntry>>>>();
  const listingOf = (folder: string): Promise<FileRead<Map<string, ResolvedEntry>>> => {
    const kept = listings.get(folder) ?? listOwnEntries(folder, ignoreLink).then(
      (entries): FileRead<Map<string, ResolvedEntry>> => ({ kind: 'read', answer: lowerCased(entries) }),
      (err: unknown): FileRead<Map<string, ResolvedEntry>> => errnoCode(err) === 'ENOENT'
        ? { kind: 'read', answer: new Map() } : { kind: 'unreadable', reason: errorMessage(err) },
    );
    listings.set(folder, kept);
    return kept;
  };
  const walk = async (from: string, segments: readonly string[]): Promise<FileRead<string[] | undefined>> => {
    const found: string[] = [];
    for (const [i, segment] of segments.entries()) {
      const listing = await listingOf(join(from, ...found));
      if (listing.kind === 'unreadable') return listing;
      const entry = listing.answer.get(segment.toLowerCase());
      if (entry === undefined || entry.isDirectory === (i === segments.length - 1)) return { kind: 'read', answer: undefined };
      found.push(entry.name);
    }
    return { kind: 'read', answer: found };
  };
  // The Data folder may be a link, as one on another drive is, where a link below it is a deployed file.
  return async (path: string): Promise<FileRead<string[] | undefined>> => {
    const [first = '', ...below] = path.split('/');
    if (below.length === 0 || first.toLowerCase() !== DATA_FOLDER.toLowerCase()) return walk(root, path.split('/'));
    const found = await walk(join(root, DATA_FOLDER), below);
    return found.kind === 'read' && found.answer !== undefined ? { kind: 'read', answer: [DATA_FOLDER, ...found.answer] } : found;
  };
}

// The lines around the whitelist are the user's to manage (docs/wiki/workflows.md), so only a missing whitelist is appended.
function whitelistAfter(ignoreList: string, whitelist: string): string {
  const whitelistLines = whitelist.trimEnd().split('\n');
  const text = ignoreList.replaceAll('\r\n', '\n');
  const gitLines = (withSourceModLines(text, { submodules: [], plain: [] }) ?? text).trimEnd().split('\n').map((line) => line.replace(/(?<!\\) +$/, ''));
  const holdsWhitelist = gitLines.some((_, at) => whitelistLines.every((line, i) => gitLines[at + i] === line));
  if (holdsWhitelist) return '';
  const lineEnding = ignoreList.includes('\r\n') ? '\r\n' : '\n';
  const separator = ignoreList === '' || ignoreList.endsWith('\n') ? '' : lineEnding;
  return separator + whitelist.replaceAll('\n', lineEnding);
}

// MO2 reads a mod folder as the game reads its Data folder.
const isModFolder = async (instanceRoot: string, folder: string): Promise<boolean> =>
  await isWithin(dirname(folder), modsDir(instanceRoot)) && await isWithin(modsDir(instanceRoot), dirname(folder));

export function mo2Repository(context: Mo2Context, publisherFile: ConfigurationFile | undefined): Mo2Repository {
  const { instanceRoot } = context;
  const whitelist = whitelistIgnoreList(publisherFile?.name);

  return {
    async writeIgnoreList() {
      const file = ignoreListFile(instanceRoot);
      const existed = await exists(file);
      let appended = '';
      await putIfChanged(file, async (before) => {
        const whitelisted = whitelistAfter(before, whitelist);
        const after = whitelisted === '' ? before : withSourceModLines(before + whitelisted, await sourceFoldersOf(instanceRoot)) ?? before + whitelisted;
        appended = after.startsWith(before) ? after.slice(before.length) : whitelisted;
        return before + appended;
      }, { ifMissing: '' });
      return async () => {
        await putIfChanged(file, (text) => {
          const at = text.lastIndexOf(appended);
          return at === -1 ? text : text.slice(0, at) + text.slice(at + appended.length);
        });
        if (!existed && await get(file, '') === '') await remove(file);
      };
    },

    async filesKept() {
      const mods = await readOrAbsent(() => listFolders(modsDir(instanceRoot), ignoreSkippedLink, listDirByStamp), []);
      const inFolders = await Promise.all(mods.map(async (mod) => {
        const folder = join(modsDir(instanceRoot), mod);
        return (await listEntries(folder, ignoreSkippedLink, listDirByStamp)).map(({ name }) => join(folder, name)).filter((path) => isManifestPath(instanceRoot, path));
      }));
      const fixed = [
        join(instanceRoot, GIT_DIR), ignoreListFile(instanceRoot), submodulesFile(instanceRoot), recordIndexDir(instanceRoot),
        hashIndexDir(instanceRoot), sourceRootDir(instanceRoot), ...Object.values(sortingRuleFilePaths(instanceRoot)),
      ];
      const held = (await Promise.all(fixed.map(async (path) => (await existsByStamp(path) ? [path] : [])))).flat();
      return {
        present: [...held, ...inFolders.flat()],
        owns: (path) => fixed.includes(path) || isManifestPath(instanceRoot, path),
      };
    },

    writeHeldWholeLines: (modFolders, held) =>
      folderLinesWritten(instanceRoot, modsDir(instanceRoot), modFolders, 'mod folders held whole', (list, names) => withHeldWholeLines(list, names, held)),

    commitFolder: async (folder, message) => {
      const names = namesIn(modsDir(instanceRoot), [folder]);
      await commitFolder(instanceRoot, folder, message, (list) => {
        const lines = withHeldWholeLines(list, names, true);
        if (lines === undefined) throw new Error('the .gitignore HEAD holds has a marker of the mod folders held whole with no match, so the lines that let the folder in cannot be committed');
        return lines;
      });
    },
  };
}

/** Which game files a mod's files take. */
export function mo2GameFiles(
  { instanceRoot }: Mo2Context, { gameFileHash }: Pick<HashIndex, 'gameFileHash'>, deployedPath: DeployedPath,
): Pick<InstanceAdapter, 'gameFiles' | 'gameFilesTakenBy'> {
  const gameFileIn = async (find: ReturnType<typeof caseBlindFinder>, root: string, modFilePath: string): Promise<FileRead<GameFile | undefined>> => {
    const found = await find(modFilePath);
    if (found.kind === 'unreadable' || found.answer === undefined) return found.kind === 'unreadable' ? found : { kind: 'read', answer: undefined };
    const path = found.answer.join('/');
    const hashed = await gameFileHash(join(root, ...found.answer));
    return hashed.kind === 'unreadable' ? hashed : { kind: 'read', answer: { root, path, hash: hashed.answer.hash } };
  };
  const gameFiles: InstanceAdapter['gameFiles'] = async ({ root, steamRoot }, modFilePaths) => {
    const places = [root, ...steamRoot === undefined ? [] : [steamRoot]].map((at) => ({ at, find: caseBlindFinder(at) }));
    const files = new Map<string, GameFile>();
    const unreadable: Record<string, string> = {};
    for (const modFilePath of modFilePaths) {
      const reads = [];
      for (const { at, find } of places) reads.push(await gameFileIn(find, at, modFilePath));
      const failed = reads.find((read) => read.kind === 'unreadable');
      if (failed !== undefined) { unreadable[modFilePath] = failed.reason; continue; }
      for (const read of reads) if (read.kind === 'read' && read.answer !== undefined) files.set(`${read.answer.root}/${read.answer.path.toLowerCase()}`, read.answer);
    }
    return { files: [...files.values()], unreadable };
  };

  return {
    gameFiles,

    async gameFilesTakenBy(place, folder, paths) {
      const { files, notes } = paths === undefined ? await filesBelow(folder) : { files: paths.map((relativePath) => ({ relativePath })), notes: [] };
      const inGameFolder = await isModFolder(instanceRoot, folder) ? deployedPath : (path: string) => path;
      const asked = files.flatMap(({ relativePath }) => {
        const path = inGameFolder(relativePath);
        return path === undefined ? [] : [{ path, pathInFolder: relativePath }];
      });
      const taken = await gameFiles(place, asked.map(({ path }) => path));
      const [reason] = Object.values(taken.unreadable);
      if (reason !== undefined) return { kind: 'unreadable', reason };
      const gameFilesTaken = asked.flatMap(({ path, pathInFolder }) =>
        taken.files.filter((file) => file.path.toLowerCase() === path.toLowerCase()).map((file) => ({ ...file, pathInFolder })));
      return { kind: 'read', answer: { gameFiles: gameFilesTaken, notes } };
    },
  };
}
