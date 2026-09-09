// Pure path arithmetic over an MO2 instance root — no vscode import, no backend call
// (Mod Management never calls it, CLAUDE.md) — so it is unit-testable without a VS Code harness.

import { join } from 'node:path';
import { OVERWRITE_ORIGIN } from './loadOrderSnapshot';

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
  { label: 'overwrite/', description: "MO2's overwrite folder", choice: 'overwrite' },
  { label: 'Existing mod…', choice: 'existingMod' },
];

/** Path arithmetic only — no filesystem access. */
export function resolvePluginDestination(instanceRoot: string, choice: PluginDestinationChoice): PluginDestination {
  if (choice.kind === 'overwrite') return { path: join(instanceRoot, 'overwrite'), origin: OVERWRITE_ORIGIN };
  return { path: join(instanceRoot, 'mods', choice.modName), origin: choice.modName };
}
