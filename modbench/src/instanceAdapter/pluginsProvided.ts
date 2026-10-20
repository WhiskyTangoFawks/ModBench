// Where the game gets a file from: the merge a VFS performs over mod order.

import { pluginKey } from '../loadOrderFileCodec/pluginsText';
import { isPluginFile, isRootLevel } from '../tables/pluginFile';
import type { DataFolderPlugins, OriginProvides, PluginsProvided } from './instanceAdapter';

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
