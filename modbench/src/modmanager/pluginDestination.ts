// Pure path arithmetic over an MO2 instance root — no vscode import, no backend call
// (Mod Management never calls it, CLAUDE.md) — so it is unit-testable without a VS Code harness.

import { join } from 'node:path';
import { OVERWRITE_ORIGIN } from './loadOrderSnapshot';

export type PluginDestinationChoice =
  | { kind: 'overwrite' }
  | { kind: 'existingMod'; modName: string }
  | { kind: 'newMod'; modName: string };

export interface PluginDestination {
  path: string;
  origin: string;
}

/** Path arithmetic only: for 'newMod' the folder must already exist on disk by the time this is
 *  called — creating it is the caller's job, never this function's. */
export function resolvePluginDestination(instanceRoot: string, choice: PluginDestinationChoice): PluginDestination {
  if (choice.kind === 'overwrite') return { path: join(instanceRoot, 'overwrite'), origin: OVERWRITE_ORIGIN };
  return { path: join(instanceRoot, 'mods', choice.modName), origin: choice.modName };
}
