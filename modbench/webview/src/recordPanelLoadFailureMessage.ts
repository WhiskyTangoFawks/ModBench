import { columnKey } from '../../src/wire/columnKey';
import { pluginAddressOf } from '../../src/wire/pluginAddress';
import type { CompareOverride, PluginLoadFailure } from './types';

/** The panel keeps what it read while its own read fails, or mEdit cannot read a plugin it shows;
 *  a plugin the panel shows no column for is not its business (editor.md, States). */
export function recordPanelLoadFailureMessage(
  readFailure: string | null, failures: readonly PluginLoadFailure[], shown: readonly Pick<CompareOverride, 'plugin' | 'origin'>[],
): string | undefined {
  const shownKeys = new Set(shown.map(o => columnKey(pluginAddressOf(o))));
  const reasons = [
    ...readFailure === null ? [] : [readFailure],
    ...failures.filter(f => shownKeys.has(columnKey(f))).map(f => `"${f.name}" (${f.origin}): ${f.reason}`),
  ];
  if (reasons.length === 0) return undefined;
  return `Showing the last good read: ${reasons.join('; ')}`;
}
