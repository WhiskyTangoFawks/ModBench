// Where the game gets a file from: the merge a VFS performs over mod order.

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { isPluginFile, isRootLevel } from './pluginFile';
import type { DataFolderPlugins, FileOrigin, ModlistEntry, OriginFile, PluginsProvided } from './instanceAdapter';

export interface OriginProvides {
  readonly origin: FileOrigin;
  readonly files: readonly OriginFile[];
}

const provides = (origin: FileOrigin, files: readonly OriginFile[]): OriginProvides =>
  ({ origin, files: files.filter((file) => !file.excluded) });

/** The origins the game gets a file from, winning-first: Overwrite, then each enabled mod in mod
 *  order, each with the files nothing excludes. */
export function filesWinningFirst(
  mods: readonly ModlistEntry[], runtimeOutput: readonly OriginFile[], filesOf: (mod: string) => readonly OriginFile[],
): OriginProvides[] {
  return [
    provides({ kind: 'runtimeOutput' }, runtimeOutput),
    ...mods.flatMap((entry) => (entry.kind === 'mod' && entry.enabled ? [provides({ kind: 'mod', name: entry.name }, filesOf(entry.name))] : [])),
  ];
}

/** The plugin files at an origin's root, at the spelling of the winning copy, then each Data folder
 *  plugin no origin provides; two Data folder files that differ only in case answer the first in
 *  code-point order. */
export function pluginsProvidedOf(
  winningFirst: readonly OriginProvides[], dataFolderPlugins: DataFolderPlugins, loadedWithNoLine: readonly string[],
): PluginsProvided {
  if (dataFolderPlugins.kind !== 'listed') return dataFolderPlugins;
  const plugins = new Map<string, string>();
  const atRoots = winningFirst.flatMap(({ files }) => files).map((file) => file.relativePath)
    .filter((relativePath) => isRootLevel(relativePath) && isPluginFile(relativePath));
  for (const name of [...atRoots, ...[...dataFolderPlugins.names].sort()]) {
    if (!plugins.has(pluginKey(name))) plugins.set(pluginKey(name), name);
  }
  return { kind: 'listed', plugins, loadedWithNoLine };
}
