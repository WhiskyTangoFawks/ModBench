import { join } from 'node:path';
import { parsePlugins } from '../../loadOrderFileCodec/pluginsText';
import { creationClubListFile } from '../../tables/gamePaths';
import { isPluginFile } from '../../tables/pluginFile';
import { get, readOrAbsent, readOrReason } from '../files';
import { listOwnEntries, type IgnoredLink } from './ownEntries';
import type { DataFolderPlugins, GameFolder } from '../instanceAdapter';

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(gameFolder: GameFolder): string | undefined {
  return gameFolder.kind === 'found' ? gameFolder.dataFolder : undefined;
}

/** A file at the root of the Data folder of a game folder found, undefined when it was not. */
export function dataFolderFile(gameFolder: GameFolder, name: string): string | undefined {
  const dataFolder = dataFolderOf(gameFolder);
  return dataFolder === undefined ? undefined : join(dataFolder, name);
}

export async function listDataFolderPlugins(gameFolder: GameFolder, ignoredLink: IgnoredLink): Promise<DataFolderPlugins> {
  const dataFolder = dataFolderOf(gameFolder);
  if (dataFolder === undefined) return { kind: 'unresolved' };
  const dirents = await readOrReason(() => listOwnEntries(dataFolder, ignoredLink));
  if (dirents.kind === 'unreadable') return dirents;
  return { kind: 'listed', names: new Set(dirents.answer.filter((d) => d.isFile && isPluginFile(d.name)).map((d) => d.name)) };
}

/** The Creation Club list in a game folder found, undefined when it was not or the release has none. */
export function creationClubFileOf(gameFolder: GameFolder, gameRelease: string | undefined): string | undefined {
  return gameFolder.kind === 'found' ? creationClubListFile(gameFolder.root, gameRelease) : undefined;
}

// The game writes its Creation Club list in plugins.txt's own line format.
export async function readCreationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]> {
  const file = creationClubFileOf(gameFolder, gameRelease);
  if (file === undefined) return [];
  const text = await readOrAbsent<string | undefined>(() => get(file), undefined);
  return text === undefined ? [] : parsePlugins(text).map((entry) => entry.name);
}
