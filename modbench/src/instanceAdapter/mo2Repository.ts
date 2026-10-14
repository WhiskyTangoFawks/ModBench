// What MO2's implementation lets the instance repository hold, and which game files a mod's files override.

import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { exists, listDir, remove, write } from './files';
import type { HashIndex } from './hashIndex';
import type { GameFile, InstanceAdapter } from './instanceAdapter';
import { buildDir, ignoreListFile, WHITELIST_IGNORE_LIST } from './layout';
import type { Mo2Context } from './mo2Context';
import { originFilesIn } from './mo2Files';

type Mo2Repository = Pick<InstanceAdapter, 'overriddenGameFiles' | 'gameFilesOverriddenBy' | 'buildFolder' | 'writeIgnoreList' | 'removeIgnoreList'>;

const lowerCased = (names: readonly Dirent[]): Map<string, Dirent> => new Map(names.map((entry) => [entry.name.toLowerCase(), entry]));

// The game's folder is as case-sensitive as its file system, and a mod's paths are the game's, which ignores case.
function caseBlindFinder(dataFolder: string) {
  const listings = new Map<string, Promise<Map<string, Dirent>>>();
  const listingOf = (folder: string): Promise<Map<string, Dirent>> => {
    const kept = listings.get(folder) ?? listDir(folder).then(lowerCased, () => new Map<string, Dirent>());
    listings.set(folder, kept);
    return kept;
  };
  return async (path: string): Promise<string[] | undefined> => {
    const found: string[] = [];
    const segments = path.split('/');
    for (const [i, segment] of segments.entries()) {
      const entry = (await listingOf(join(dataFolder, ...found))).get(segment.toLowerCase());
      if (entry === undefined || entry.isDirectory() === (i === segments.length - 1)) return undefined;
      found.push(entry.name);
    }
    return found;
  };
}

export function mo2Repository(
  { instanceRoot }: Mo2Context, { gameFileHash }: Pick<HashIndex, 'gameFileHash'>,
): Mo2Repository {
  const overriddenGameFiles: InstanceAdapter['overriddenGameFiles'] = async (dataFolder, modFilePaths) => {
    const find = caseBlindFinder(dataFolder);
    const files = new Map<string, GameFile>();
    for (const modFilePath of modFilePaths) {
      const found = await find(modFilePath);
      if (found === undefined || files.has(found.join('/').toLowerCase())) continue;
      const hashed = await gameFileHash(join(dataFolder, ...found));
      if (hashed.kind === 'unreadable') return hashed;
      files.set(found.join('/').toLowerCase(), { path: found.join('/'), ...hashed.answer });
    }
    return { kind: 'read', answer: [...files.values()] };
  };

  return {
    buildFolder: buildDir(instanceRoot),

    async writeIgnoreList() {
      const file = ignoreListFile(instanceRoot);
      if (await exists(file)) throw new Error(`${file} already exists; git init does not write over it.`);
      await write(file, WHITELIST_IGNORE_LIST);
    },

    removeIgnoreList: () => remove(ignoreListFile(instanceRoot)),

    overriddenGameFiles,

    async gameFilesOverriddenBy(dataFolder, mod) {
      const { files } = await originFilesIn(instanceRoot, { kind: 'mod', name: mod });
      return overriddenGameFiles(dataFolder, files.map((file) => file.relativePath));
    },
  };
}
