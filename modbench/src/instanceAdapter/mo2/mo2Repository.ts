// What MO2's implementation lets the instance repository hold, and which game files a mod's files take.

import { join } from 'node:path';
import { errnoCode } from '../errno';
import { errorMessage } from '../../ports/errorMessage';
import { exists, get, ignoreSkippedLink, listEntries, remove, type ResolvedEntry, write } from '../files';
import type { HashIndex } from '../downloadedFileContents/hashIndex';
import type { FileRead, GameFile, InstanceAdapter } from '../instanceAdapter';
import { ignoreListFile, WHITELIST_IGNORE_LIST } from './layout';
import type { Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';

type Mo2Repository = Pick<InstanceAdapter, 'gameFiles' | 'gameFilesTakenBy' | 'writeIgnoreList'>;

const lowerCased = (names: readonly ResolvedEntry[]): Map<string, ResolvedEntry> => new Map(names.map((entry) => [entry.name.toLowerCase(), entry]));

// The game's folder is as case-sensitive as its file system, and a mod's paths are the game's, which ignores case.
function caseBlindFinder(dataFolder: string) {
  const listings = new Map<string, Promise<FileRead<Map<string, ResolvedEntry>>>>();
  const listingOf = (folder: string): Promise<FileRead<Map<string, ResolvedEntry>>> => {
    const kept = listings.get(folder) ?? listEntries(folder, ignoreSkippedLink).then(
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

export function mo2Repository(
  context: Mo2Context, { gameFileHash }: Pick<HashIndex, 'gameFileHash'>,
): Mo2Repository {
  const { instanceRoot } = context;
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
      const before = await exists(file) ? await get(file) : undefined;
      if (before === undefined) {
        await write(file, WHITELIST_IGNORE_LIST);
        return () => remove(file);
      }
      const held = new Set(before.split(/\r?\n/));
      if (!WHITELIST_IGNORE_LIST.split('\n').every((line) => line === '' || held.has(line))) {
        await write(file, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${WHITELIST_IGNORE_LIST}`);
      }
      return () => write(file, before);
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
