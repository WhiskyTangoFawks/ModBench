// The plugin files the effective load order does not point at: an overridden plugin, a plugin in a
// disabled mod, or one no line names. The snapshot names them too (ADR-0013).

import { isRootLevel } from './fileConflictIndex';
import { exactPluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { isPluginFile, type OriginFile } from '../instanceAdapter/instanceAdapter';

interface PluginOutsideLoadOrder {
  name: string;
  path: string;
  /** The origin providing this plugin. */
  origin: string;
}

/** One rule covers both cases: an overridden plugin is a pair whose filename is loaded from a
 *  different origin, a never-listed file one whose filename is not loaded at all. */
export function findPluginsOutsideLoadOrder(
  filesByOrigin: Iterable<readonly [string, readonly OriginFile[]]>, loadOrder: PluginAddress[],
): PluginOutsideLoadOrder[] {
  const loaded = new Set(loadOrder.map(exactPluginAddressKey));

  const outside: PluginOutsideLoadOrder[] = [];
  for (const [origin, files] of filesByOrigin) {
    for (const file of files) {
      if (!isRootLevel(file.relativePath) || !isPluginFile(file.relativePath)) continue;
      if (loaded.has(exactPluginAddressKey({ name: file.relativePath, origin }))) continue;
      outside.push({ name: file.relativePath, path: file.sourcePath, origin });
    }
  }
  return outside;
}
