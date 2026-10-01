import { columnKey } from './columnKey';
import type { CompareOverride, PluginLoadFailure } from './types';

/** The panel keeps what it read while mEdit cannot read a plugin it shows; a plugin the panel
 *  shows no column for is not its business (editor.md, States). */
export function recordPanelLoadFailureMessage(
  failures: readonly PluginLoadFailure[], shown: readonly Pick<CompareOverride, 'plugin' | 'origin'>[],
): string | undefined {
  const shownKeys = new Set(shown.map(o => columnKey(o.plugin, o.origin)));
  const reasons = failures
    .filter(f => shownKeys.has(columnKey(f.name, f.origin)))
    .map(f => `${f.name}: ${f.reason}`);
  if (reasons.length === 0) return undefined;
  return `Showing the last good read: ${reasons.join('; ')}`;
}
