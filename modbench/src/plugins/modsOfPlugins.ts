import type { FileOrigin, InstanceValue } from '../instanceLoader/instance';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { modOrigin, RUNTIME_OUTPUT } from '../instanceLoader/fileConflictIndex';
import { pluginArgumentOf } from '../drivingLib/argument';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';

/** The mods and Overwrite the selected plugin rows come from (plugins.md, The highlight, stories 3 and 6).
 *  A plugin from the game folder, or from no listed mod, comes from none. */
export function modsOfPlugins(value: Pick<InstanceValue, 'mods' | 'entryKey'>, selection: readonly unknown[]): FileOrigin[] {
  return selection.flatMap((row) => {
    const origin = pluginArgumentOf(row)?.plugin.origin;
    if (origin === undefined) return [];
    if (origin === OVERWRITE_ORIGIN) return [RUNTIME_OUTPUT];
    const owner = modOfOrigin(value, origin);
    return owner ? [modOrigin(owner.name)] : [];
  });
}
