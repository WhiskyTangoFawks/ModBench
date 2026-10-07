// The plugin files the effective load order does not point at: an overridden plugin in an enabled
// mod, or any plugin in a disabled mod. The snapshot names them too (ADR-0013).

import { isRootLevel, type FileConflictIndex } from './fileConflictIndex';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { isPluginFile } from '../instanceAdapter/instanceAdapter';

interface PluginOutsideLoadOrder {
  name: string;
  path: string;
  /** The mod folder providing this plugin. */
  origin: string;
}

/** One rule covers both cases: an overridden plugin is a pair whose filename is loaded from a
 *  different origin, a never-listed file one whose filename is not loaded at all. */
export function findPluginsOutsideLoadOrder(
  index: FileConflictIndex, loadOrder: PluginAddress[],
): PluginOutsideLoadOrder[] {
  const loaded = new Set(loadOrder.map(pluginAddressKey));

  const outside: PluginOutsideLoadOrder[] = [];
  for (const [mod, files] of index.filesByMod) {
    for (const file of files) {
      if (!isRootLevel(file.relativePath) || !isPluginFile(file.relativePath)) continue;
      if (loaded.has(pluginAddressKey({ name: file.relativePath, origin: mod }))) continue;
      outside.push({ name: file.relativePath, path: file.sourcePath, origin: mod });
    }
  }
  return outside;
}
