import { join } from 'node:path';
import { parsePlugins } from '../../loadOrderFileCodec/pluginsText';
import { creationClubListFile } from '../../tables/gamePaths';
import { isPluginFile } from '../../tables/pluginFile';
import { get, listDir, readOrAbsent, readOrReason } from '../files';
import type { DataFolderPlugins, GameFolder } from '../instanceAdapter';

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(folder: GameFolder): string | undefined {
  return folder.kind === 'found' ? folder.dataFolder : undefined;
}

/** A file at the root of the Data folder of a game folder found, undefined when it was not. */
export function dataFolderFile(folder: GameFolder, name: string): string | undefined {
  const dataFolder = dataFolderOf(folder);
  return dataFolder === undefined ? undefined : join(dataFolder, name);
}

export async function listDataFolderPlugins(gameFolder: GameFolder): Promise<DataFolderPlugins> {
  const dataFolder = dataFolderOf(gameFolder);
  if (dataFolder === undefined) return { kind: 'unresolved' };
  const dirents = await readOrReason(() => listDir(dataFolder));
  if (dirents.kind === 'unreadable') return dirents;
  return { kind: 'listed', names: new Set(dirents.answer.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name)) };
}

// The game writes its Creation Club list in plugins.txt's own line format.
export async function readCreationClubList(gameFolder: GameFolder, gameRelease: string | undefined): Promise<string[]> {
  const file = gameFolder.kind === 'found' ? creationClubListFile(gameFolder.root, gameRelease) : undefined;
  if (file === undefined) return [];
  const text = await readOrAbsent<string | undefined>(() => get(file), undefined);
  return text === undefined ? [] : parsePlugins(text).map((entry) => entry.name);
}
