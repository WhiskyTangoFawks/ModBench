// Where a new plugin lands, read off the Instance's own value — no vscode import, no backend
// call (Mod Management never calls it, CLAUDE.md), and no path joined here.

import type { InstanceValue } from '../instance/instance';
import { OVERWRITE_ORIGIN } from '../instance/loadOrderSnapshot';

export type PluginDestinationChoice =
  | { kind: 'overwrite' }
  | { kind: 'existingMod'; modName: string };

export interface PluginDestination {
  path: string;
  origin: string;
}

/** `overwrite/` is first so `showQuickPick` pre-highlights it — it has no `activeItem`, and
 *  array order is the only way to set one. `choice`, not `kind`: `kind` is
 *  `QuickPickItem`'s own reserved separator-row property. */
export const PLUGIN_DESTINATION_OPTIONS: readonly { label: string; description?: string; choice: PluginDestinationChoice['kind'] }[] = [
  { label: OVERWRITE_ORIGIN + '/', description: "MO2's overwrite folder", choice: OVERWRITE_ORIGIN },
  { label: 'Existing mod…', choice: 'existingMod' },
];

/** `undefined` when the value names no folder for the chosen mod — a mod that left the modlist
 *  between the pick and the answer. */
export function resolvePluginDestination(
  value: Pick<InstanceValue, 'paths'>, choice: PluginDestinationChoice,
): PluginDestination | undefined {
  if (choice.kind === OVERWRITE_ORIGIN) return { path: value.paths.overwriteDir, origin: OVERWRITE_ORIGIN };
  const path = value.paths.modDirs.get(choice.modName);
  return path === undefined ? undefined : { path, origin: choice.modName };
}
