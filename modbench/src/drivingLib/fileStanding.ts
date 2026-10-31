import type { PluginStanding } from '../instanceLoader/pluginStanding';
import type { Standing } from './columnStatus';

/** The standing the instance gives the column of the file asked for: only a plugin the game does not load, and no other
 *  columns beside it, reads as overridden or as not active (editor.md, A column's header). */
export function fileStanding(
  { pluginActive, columnsShown, standing }: { pluginActive: boolean; columnsShown: boolean; standing: PluginStanding },
): Standing {
  const unloaded = !pluginActive && !columnsShown;
  return {
    overriddenBy: unloaded && standing.kind === 'overridden' ? standing.by : null,
    notActive: unloaded && standing.kind === 'disabled',
  };
}
