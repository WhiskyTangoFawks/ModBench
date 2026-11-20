import type { PluginLoadFailure } from '../client';
import type { Reporter } from '../ports/reporter';
import { pluginAddressKey } from '../wire/pluginAddress';

/** common.md, States, stories 2 and 6: one Output line for each plugin's failed read, again only
 *  when its reason changes. The views say whether its rows still show. */
export function tellFailedReads(reporter: Pick<Reporter, 'shownOnSurface'>): (failures: readonly PluginLoadFailure[]) => void {
  let told = new Set<string>();
  const keyOf = (f: PluginLoadFailure): string => JSON.stringify([pluginAddressKey(f), f.reason]);
  return (failures) => {
    for (const f of failures) {
      if (!told.has(keyOf(f))) reporter.shownOnSurface('error', `Failed to read "${f.name}" (${f.origin}).`, f.reason);
    }
    told = new Set(failures.map(keyOf));
  };
}
