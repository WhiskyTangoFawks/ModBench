// #288: turns a New Plugin destination choice (the composition root's QuickPick — overwrite/, an
// existing mod, or a freshly installed mod folder) into the physical (path, origin) pair Editing's
// create endpoint needs. Pure path arithmetic over an MO2 instance root — no vscode import, no
// backend call (Mod Management never calls it, CLAUDE.md) — split out of extension.ts so it is
// unit-testable without a VS Code harness, same reason explicitSession.ts's own resolvers are.

import { join } from 'node:path';
import { OVERWRITE_ORIGIN } from './explicitSession';

export type PluginDestinationChoice =
  | { kind: 'overwrite' }
  | { kind: 'existingMod'; modName: string }
  | { kind: 'newMod'; modName: string };

export interface PluginDestination {
  path: string;
  origin: string;
}

/** Resolves a destination choice to the physical mod folder (or overwrite/) a new plugin should be
 *  written into. Path arithmetic only: for 'newMod' the folder itself must already exist on disk
 *  by the time this is used — creating it is Mod Management's own job (`installMod`), done by the
 *  caller before this is reached, never by this function. */
export function resolvePluginDestination(instanceRoot: string, choice: PluginDestinationChoice): PluginDestination {
  if (choice.kind === 'overwrite') return { path: join(instanceRoot, 'overwrite'), origin: OVERWRITE_ORIGIN };
  return { path: join(instanceRoot, 'mods', choice.modName), origin: choice.modName };
}
