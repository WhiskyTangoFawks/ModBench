// Pure path arithmetic over an MO2 instance root — no vscode import, no backend call
// (Mod Management never calls it, CLAUDE.md) — so it is unit-testable without a VS Code harness.

import { OVERWRITE_ORIGIN } from './loadOrderSnapshot';
import { OVERWRITE_DIR_NAME, modDir, overwriteDir } from '../mo2Codecs/layout';

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
  { label: OVERWRITE_DIR_NAME + '/', description: "MO2's overwrite folder", choice: OVERWRITE_DIR_NAME },
  { label: 'Existing mod…', choice: 'existingMod' },
];

/** Path arithmetic only — no filesystem access. */
export function resolvePluginDestination(instanceRoot: string, choice: PluginDestinationChoice): PluginDestination {
  if (choice.kind === OVERWRITE_DIR_NAME) return { path: overwriteDir(instanceRoot), origin: OVERWRITE_ORIGIN };
  return { path: modDir(instanceRoot, choice.modName), origin: choice.modName };
}
