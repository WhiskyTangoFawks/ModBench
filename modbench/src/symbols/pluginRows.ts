import type { InstanceValue } from '../instanceLoader/instance';
import { pluginOrderOf, unplaced } from '../instanceLoader/pluginOrder';

/** Every plugin of the instance once: the plugins with a line, and the ones the game loads with no line (ADR-0013). */
export function pluginRowsOf({ plugins, pluginsLoadedWithNoLine }: Pick<InstanceValue, 'plugins' | 'pluginsLoadedWithNoLine'>) {
  const { loadedWithNoLine, fromLines, others } = pluginOrderOf({ plugins, pluginsLoadedWithNoLine: pluginsLoadedWithNoLine ?? [] }, unplaced);
  return [...loadedWithNoLine, ...fromLines, ...others];
}
