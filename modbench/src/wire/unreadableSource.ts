import type { components } from './generated/api';
import { columnKey, type ColumnKey } from './columnKey';
import type { PluginAddress } from './pluginAddress';

/** Why a tracked plugin's source does not read, and whether decompile gets past it. */
export type UnreadableSource = components['schemas']['UnreadableSource'];

/** The plugins whose source is unreadable, each by its column. */
export function unreadableSources(
  plugins: readonly (PluginAddress & { pluginSourceUnreadable?: UnreadableSource | null })[],
): Map<ColumnKey, UnreadableSource> {
  return new Map(plugins.flatMap((p) => p.pluginSourceUnreadable == null ? [] : [[columnKey(p), p.pluginSourceUnreadable] as const]));
}
