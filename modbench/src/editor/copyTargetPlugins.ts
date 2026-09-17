import type { PluginMetadata } from '../client';

// 'copy-as-override' excludes every plugin that already carries the record (xEdit's CopyInto
// module filter): offering one would silently replace that override's content. 'copy-as-new'
// allocates a fresh FormID, so the list is ignored for it.
export type CopyGesture = 'copy-as-new' | 'copy-as-override';

export function copyTargetPlugins(
  allPlugins: PluginMetadata[], gesture: CopyGesture, pluginsCarryingRecord: readonly string[],
): PluginMetadata[] {
  const carrying = new Set(pluginsCarryingRecord);
  return allPlugins.filter(p => !p.isImmutable && (gesture !== 'copy-as-override' || !carrying.has(p.name)));
}
