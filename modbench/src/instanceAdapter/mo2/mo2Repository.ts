// What MO2's implementation lets the instance repository hold, and which game files a mod's files take.

import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { exists, get, GIT_DIR, ignoreSkippedLink, listDir, listFolders, readOrAbsent, listEntries, putIfChanged, remove, type ResolvedEntry } from '../files';
import { ignoreLink, listOwnEntries } from '../gameFolder/ownEntries';
import type { HashIndex } from '../fileContents/hashIndex';
import type { DeployedPath, FileRead, GameFile, GamePlace, InstanceAdapter, UnsearchedFolder } from '../instanceAdapter';
import { DATA_FOLDER } from '../gameFolder/gameFolderResolver';
import { isWithin } from '../gameFolder/pathWithin';
import {
  hashIndexDir, ignoreListFile, isManifestPath, isOwnManifest, isSkippedByManifestSearch, modsDir, recordIndexDir,
  sourceRootDir, statCacheDir, submodulesFile, whitelistIgnoreList, withOtherManifestLines, withSourceModLines,
} from './layout';
import type { ConfigurationFile, ManagerAdapter } from '../publisher';
import { currentDownloadsDir, type Mo2Context } from './mo2Context';
import { filesBelow } from './mo2Files';

type Mo2Repository = Pick<InstanceAdapter, 'gameFiles' | 'gameFilesTakenBy' | 'writeIgnoreList' | 'otherManifests' | 'writeOtherManifestLines'> & Pick<ManagerAdapter, 'filesKept'>;

// A manifest outside the mod folders, by the names of the folders down to it and its own.
interface FoundManifest { readonly segments: readonly string[]; readonly folder: string }

interface ManifestSearch {
  readonly found: readonly FoundManifest[];
  readonly unsearched: readonly UnsearchedFolder[];
  /** Whether `path` is where the search would find a manifest, there now or not. */
  readonly owns: (path: string) => boolean;
}

const nameOf = (folders: readonly string[]): string => `${folders.join('/')}/`;

// A manifest's folder holds no other manifest (modlist-repository.md, Restore from manifest, story 14): each of a nested pair is refused, naming the other.
function nestedAmong(names: readonly string[]): Map<string, string> {
  const why = new Map<string, string[]>();
  const add = (name: string, reason: string): void => { why.set(name, [...why.get(name) ?? [], reason]); };
  for (const inner of names) {
    for (const outer of names.filter((name) => name !== inner && inner.startsWith(name))) {
      add(inner, `its folder is inside the folder of '${outer}'`);
      add(outer, `its folder holds the folder of '${inner}'`);
    }
  }
  return new Map([...why].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, reasons]) => [name, `was skipped: ${reasons.join('; ')}.`]));
}

// modlist-repository.md, The repository, story 2. A link is not followed: the folder it reaches can be outside the instance.
// A folder it cannot read is named, and the rest are searched (Every mod, story 4).
async function searchForOtherManifests(context: Mo2Context): Promise<ManifestSearch> {
  const { instanceRoot } = context;
  const downloads = await currentDownloadsDir(context);
  const isSkipped = (folders: readonly string[]): boolean =>
    (folders.length === 1 && isSkippedByManifestSearch(folders[0] ?? '')) || relative(join(instanceRoot, ...folders), downloads) === '';
  const found: FoundManifest[] = [];
  const unsearched: UnsearchedFolder[] = [];
  const search = async (folders: readonly string[]): Promise<void> => {
    const folder = join(instanceRoot, ...folders);
    let entries: Dirent[];
    try {
      entries = await listDir(folder);
    } catch (err) {
      if (folders.length === 0) throw err;
      if (errnoCode(err) !== 'ENOENT') unsearched.push({ name: nameOf(folders), reason: errorMessage(err) });
      return;
    }
    const name = folders.at(-1);
    const manifest = name === undefined ? undefined : entries.find((entry) => entry.isFile() && isOwnManifest(name, entry.name));
    if (manifest !== undefined) found.push({ segments: [...folders, manifest.name], folder });
    for (const child of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      if (!isSkipped([...folders, child])) await search([...folders, child]);
    }
  };
  await search([]);
  const unread = new Set(unsearched.map(({ name }) => name));
  const owns = (path: string): boolean => {
    const inInstance = relative(instanceRoot, path);
    const folders = inInstance.split(sep).slice(0, -1);
    const above = folders.map((_, at) => folders.slice(0, at + 1));
    return folders.length > 0 && folders[0] !== '..' && !isAbsolute(inInstance) && isOwnManifest(folders.at(-1) ?? '', inInstance.split(sep).at(-1) ?? '')
      && !above.some((at) => isSkipped(at) || unread.has(nameOf(at)));
  };
  return { found, unsearched, owns };
}

async function otherManifestLinesWritten(context: Mo2Context): Promise<void> {
  const { instanceRoot } = context;
  const file = ignoreListFile(instanceRoot);
  if (!(await exists(file))) return;
  const { found, unsearched } = await searchForOtherManifests(context);
  if (unsearched.length > 0) {
    throw new Error(`The lines of the manifests outside the mod folders are left as they are in ${file}: ${
      unsearched.map(({ name, reason }) => `'${name}' could not be searched: ${reason}`).join('; ')}`);
  }
  await putIfChanged(file, (before) => {
    const after = withOtherManifestLines(before, found.map(({ segments }) => segments));
    if (after === undefined) throw new Error(`${file} has a marker of the manifests outside the mod folders with no match, so their lines are left as they are`);
    return after;
  });
}

const lowerCased = (names: readonly ResolvedEntry[]): Map<string, ResolvedEntry> => new Map(names.map((entry) => [entry.name.toLowerCase(), entry]));

// The game's folder is as case-sensitive as its file system, and a mod's paths are the game's, which ignores case.
function caseBlindFinder({ root, holdsDataFiles }: GamePlace) {
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
    if (!holdsDataFiles) return { kind: 'read', answer: undefined };
    const found = await walk(join(root, DATA_FOLDER), below);
    return found.kind === 'read' && found.answer !== undefined ? { kind: 'read', answer: [DATA_FOLDER, ...found.answer] } : found;
  };
}

// The lines around the whitelist are the user's to manage (docs/wiki/workflows.md), so only a missing whitelist is appended.
function whitelistAfter(ignoreList: string, whitelist: string): string {
  const whitelistLines = whitelist.trimEnd().split('\n');
  const text = ignoreList.replaceAll('\r\n', '\n');
  const gitLines = (withSourceModLines(text, []) ?? text).trimEnd().split('\n').map((line) => line.replace(/(?<!\\) +$/, ''));
  const holdsWhitelist = gitLines.some((_, at) => whitelistLines.every((line, i) => gitLines[at + i] === line));
  if (holdsWhitelist) return '';
  const lineEnding = ignoreList.includes('\r\n') ? '\r\n' : '\n';
  const separator = ignoreList === '' || ignoreList.endsWith('\n') ? '' : lineEnding;
  return separator + whitelist.replaceAll('\n', lineEnding);
}

// MO2 reads a mod folder as the game reads its Data folder.
const isModFolder = async (instanceRoot: string, folder: string): Promise<boolean> =>
  await isWithin(dirname(folder), modsDir(instanceRoot)) && await isWithin(modsDir(instanceRoot), dirname(folder));

export function mo2Repository(
  context: Mo2Context, { gameFileHash }: Pick<HashIndex, 'gameFileHash'>, publisherFile: ConfigurationFile | undefined, deployedPath: DeployedPath,
): Mo2Repository {
  const { instanceRoot } = context;
  const whitelist = whitelistIgnoreList(publisherFile?.name);
  const gameFiles: InstanceAdapter['gameFiles'] = async (place, modFilePaths) => {
    const find = caseBlindFinder(place);
    const files = new Map<string, GameFile>();
    const unreadable: Record<string, string> = {};
    for (const modFilePath of modFilePaths) {
      const found = await find(modFilePath);
      if (found.kind === 'unreadable') { unreadable[modFilePath] = found.reason; continue; }
      const names = found.answer;
      if (names === undefined || files.has(names.join('/').toLowerCase())) continue;
      const hashed = await gameFileHash(join(place.root, ...names));
      if (hashed.kind === 'unreadable') { unreadable[modFilePath] = hashed.reason; continue; }
      files.set(names.join('/').toLowerCase(), { path: names.join('/'), hash: hashed.answer.hash });
    }
    return { files: [...files.values()], unreadable };
  };

  return {
    async writeIgnoreList() {
      const file = ignoreListFile(instanceRoot);
      const existed = await exists(file);
      let appended = '';
      await putIfChanged(file, (before) => {
        appended = whitelistAfter(before, whitelist);
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
      const search = await searchForOtherManifests(context);
      const mods = await readOrAbsent(() => listFolders(modsDir(instanceRoot), ignoreSkippedLink), []);
      const inFolders = await Promise.all(mods.map(async (mod) => {
        const folder = join(modsDir(instanceRoot), mod);
        return (await listEntries(folder, ignoreSkippedLink)).map(({ name }) => join(folder, name)).filter((path) => isManifestPath(instanceRoot, path));
      }));
      return {
        present: [
          join(instanceRoot, GIT_DIR), ignoreListFile(instanceRoot), submodulesFile(instanceRoot), recordIndexDir(instanceRoot),
          hashIndexDir(instanceRoot), statCacheDir(instanceRoot), sourceRootDir(instanceRoot), ...inFolders.flat(),
          ...search.found.map(({ segments }) => join(instanceRoot, ...segments)),
        ],
        owns: (path) => isManifestPath(instanceRoot, path) || search.owns(path),
      };
    },

    async otherManifests() {
      const { found, unsearched } = await searchForOtherManifests(context);
      const named = found.map(({ segments, folder }) => ({ name: nameOf(segments.slice(0, -1)), folder }));
      const nested = nestedAmong(named.map(({ name }) => name));
      return { manifests: named.filter(({ name }) => !nested.has(name)), unsearched, nested: [...nested].map(([name, reason]) => ({ name, reason })) };
    },

    writeOtherManifestLines: () => otherManifestLinesWritten(context),

    gameFiles,

    async gameFilesTakenBy(place, folder) {
      const { files, notes } = await filesBelow(folder);
      const inGameFolder = await isModFolder(instanceRoot, folder) ? deployedPath : (path: string) => path;
      const asked = files.flatMap(({ relativePath }) => {
        const path = inGameFolder(relativePath);
        return path === undefined ? [] : [{ path, pathInFolder: relativePath }];
      });
      const taken = await gameFiles(place, asked.map(({ path }) => path));
      const [reason] = Object.values(taken.unreadable);
      if (reason !== undefined) return { kind: 'unreadable', reason };
      const found = new Map(taken.files.map((file) => [file.path.toLowerCase(), file]));
      const gameFilesTaken = asked.flatMap(({ path, pathInFolder }) => {
        const file = found.get(path.toLowerCase());
        return file === undefined ? [] : [{ ...file, pathInFolder }];
      });
      return { kind: 'read', answer: { gameFiles: gameFilesTaken, notes } };
    },
  };
}
