import { OVERWRITE_ORIGIN, type PluginPlace } from '../wire/pluginAddress';
import type { InstanceValue } from './instance';

/** Where a new plugin can live: each enabled mod that has a mod folder, a source mod with its source folder, then
 *  Overwrite once its folder is read. The one place rule, for the snapshot and the create gesture. */
export function pluginPlacesOf(value: Pick<InstanceValue, 'mods' | 'paths'>): PluginPlace[] {
  const { modDirs, sourceDirs, overwriteDir } = value.paths;
  const mods = value.mods.flatMap((entry) => {
    const folder = entry.kind === 'mod' && entry.enabled ? modDirs.get(entry.name) : undefined;
    if (folder === undefined) return [];
    const sourceFolder = sourceDirs.get(entry.name);
    return [sourceFolder === undefined ? { name: entry.name, folder } : { name: entry.name, folder, sourceFolder }];
  });
  return overwriteDir === undefined ? mods : [...mods, { name: OVERWRITE_ORIGIN, folder: overwriteDir }];
}
