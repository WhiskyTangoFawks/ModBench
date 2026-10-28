// What MO2's implementation lets the instance repository hold, and which game files a mod's files take.

import { join, relative } from 'node:path';
import { errnoCode } from '../../ports/errno';
import { errorMessage } from '../../ports/errorMessage';
import { exists, get, GIT_DIR, ignoreSkippedLink, listDir, listFolders, readOrAbsent, listEntries, putIfChanged, remove, type ResolvedEntry } from '../files';
import { ignoreLink, listOwnEntries } from '../gameFolder/ownEntries';
import type { HashIndex } from '../downloadedFileContents/hashIndex';
import type { FileRead, GameFile, InstanceAdapter } from '../instanceAdapter';
import {
  defaultDownloadsDir, hashIndexDir, ignoreListFile, isManifestPath, isOtherManifestPath, isOwnManifest, isSkippedByManifestSearch, modsDir, recordIndexDir,
  sourceRootDir, statCacheDir, submodulesFile, whitelistIgnoreList, withOtherManifestLines, withSourceModLines,
} from './layout';
import type { ConfigurationFile, ManagerAdapter } from '../publisher';
import { currentDownloadsDir, type Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';

type Mo2Repository = Pick<InstanceAdapter, 'gameFiles' | 'gameFilesTakenBy' | 'writeIgnoreList' | 'otherManifests' | 'writeOtherManifestLines'> & Pick<ManagerAdapter, 'filesKept'>;

// A manifest outside the mod folders, by the names of the folders down to it and its own.
interface FoundManifest { readonly segments: readonly string[]; readonly folder: string }

// modlist-repository.md, The repository, story 2. A link is not followed: the folder it reaches can be outside the instance.
async function otherManifestsIn(context: Mo2Context): Promise<FoundManifest[]> {
  const { instanceRoot } = context;
  const downloads = await currentDownloadsDir(context).catch(() => defaultDownloadsDir(instanceRoot));
  const found: FoundManifest[] = [];
  const search = async (folder: string, segments: readonly string[]): Promise<void> => {
    const entries = await readOrAbsent(() => listDir(folder), []);
    const name = segments.at(-1);
    const manifest = name === undefined ? undefined : entries.find((entry) => entry.isFile() && isOwnManifest(name, entry.name));
    if (manifest !== undefined) {
      found.push({ segments: [...segments, manifest.name], folder });
      return;
    }
    const below = entries.filter((entry) => entry.isDirectory() && !(segments.length === 0 && isSkippedByManifestSearch(entry.name))).map((entry) => entry.name).sort();
    for (const child of below) {
      const path = join(folder, child);
      if (relative(path, downloads) !== '') await search(path, [...segments, child]);
    }
  };
  await search(instanceRoot, []);
  return found;
}

const lowerCased = (names: readonly ResolvedEntry[]): Map<string, ResolvedEntry> => new Map(names.map((entry) => [entry.name.toLowerCase(), entry]));

// The game's folder is as case-sensitive as its file system, and a mod's paths are the game's, which ignores case.
function caseBlindFinder(dataFolder: string) {
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
  return async (path: string): Promise<FileRead<string[] | undefined>> => {
    const found: string[] = [];
    const segments = path.split('/');
    for (const [i, segment] of segments.entries()) {
      const listing = await listingOf(join(dataFolder, ...found));
      if (listing.kind === 'unreadable') return listing;
      const entry = listing.answer.get(segment.toLowerCase());
      if (entry === undefined || entry.isDirectory === (i === segments.length - 1)) return { kind: 'read', answer: undefined };
      found.push(entry.name);
    }
    return { kind: 'read', answer: found };
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

export function mo2Repository(
  context: Mo2Context, { gameFileHash }: Pick<HashIndex, 'gameFileHash'>, publisherFile: ConfigurationFile | undefined,
): Mo2Repository {
  const { instanceRoot } = context;
  const whitelist = whitelistIgnoreList(publisherFile?.name);
  const gameFiles: InstanceAdapter['gameFiles'] = async (dataFolder, modFilePaths) => {
    const find = caseBlindFinder(dataFolder);
    const files = new Map<string, GameFile>();
    const unreadable: Record<string, string> = {};
    for (const modFilePath of modFilePaths) {
      const found = await find(modFilePath);
      if (found.kind === 'unreadable') { unreadable[modFilePath] = found.reason; continue; }
      const names = found.answer;
      if (names === undefined || files.has(names.join('/').toLowerCase())) continue;
      const hashed = await gameFileHash(join(dataFolder, ...names));
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
      const mods = await readOrAbsent(() => listFolders(modsDir(instanceRoot), ignoreSkippedLink), []);
      const inFolders = await Promise.all(mods.map(async (mod) => {
        const folder = join(modsDir(instanceRoot), mod);
        return (await listEntries(folder, ignoreSkippedLink)).map(({ name }) => join(folder, name)).filter((path) => isManifestPath(instanceRoot, path));
      }));
      return {
        present: [
          join(instanceRoot, GIT_DIR), ignoreListFile(instanceRoot), submodulesFile(instanceRoot), recordIndexDir(instanceRoot),
          hashIndexDir(instanceRoot), statCacheDir(instanceRoot), sourceRootDir(instanceRoot), ...inFolders.flat(),
          ...(await otherManifestsIn(context)).map(({ segments }) => join(instanceRoot, ...segments)),
        ],
        owns: (path) => isManifestPath(instanceRoot, path) || isOtherManifestPath(instanceRoot, path),
      };
    },

    otherManifests: async () =>
      (await otherManifestsIn(context)).map(({ segments, folder }) => ({ name: `${segments.slice(0, -1).join('/')}/`, folder })),

    async writeOtherManifestLines() {
      const file = ignoreListFile(instanceRoot);
      if (!(await exists(file))) return;
      const manifests = (await otherManifestsIn(context)).map(({ segments }) => segments);
      await putIfChanged(file, (before) => {
        const after = withOtherManifestLines(before, manifests);
        if (after === undefined) throw new Error(`${file} has a marker of the manifests outside the mod folders with no match, so their lines are left as they are`);
        return after;
      });
    },

    gameFiles,

    async gameFilesTakenBy(dataFolder, mod) {
      const { files, notes } = await originFilesIn(context, { kind: 'mod', name: mod }, false, 'list');
      const taken = await gameFiles(dataFolder, files.map((file) => file.relativePath));
      const [reason] = Object.values(taken.unreadable);
      return reason === undefined ? { kind: 'read', answer: { gameFiles: taken.files, notes } } : { kind: 'unreadable', reason };
    },
  };
}
