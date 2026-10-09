import { columnKey, type ColumnKey } from './columnKey';
import type { UnreadableSource } from './messages';
import type { PluginAddress } from './pluginAddress';

export type { UnreadableSource };

/** The plugins whose source is unreadable, each by its column. */
export function unreadableSources(
  plugins: readonly (PluginAddress & { pluginSourceUnreadable?: UnreadableSource | null })[],
): Map<ColumnKey, UnreadableSource> {
  return new Map(plugins.flatMap((p) => p.pluginSourceUnreadable == null ? [] : [[columnKey(p), p.pluginSourceUnreadable] as const]));
}
