// Deploy and purge as deploy commands (target-architecture.d2's `deploy` box): decide which
// files to hardlink and hand MO2 files the plan to execute. No reporter, no dialog — Toolbox
// turns the result into what the user sees.

import {
  deployToGameData, purgeFromGameData, type DeployOutcome, type DeployLink,
  type DeployWarning, type LoadOrderDeployment, type PurgeOutcome,
} from '../mo2Files/files';
import { pluginsFile } from '../mo2Files/layout';
import type { FileWinners } from '../instance/fileConflictIndex';
import type { GameDirectory } from '../mo2Files/gameDirectory';

export type { DeployWarning };

/** The slice of the Instance's value deploy needs, named on its own rather than imported from
 *  `../instance` — commands never read the read model (ADR-0015 invariant 2). */
export interface DeployableValue {
  activeProfile: string;
  files: FileWinners;
  gameDirectory: GameDirectory | undefined;
}

/** `wrote` is false when a precondition aborted the run, or when purge found nothing deployed —
 *  in both cases Data/ and the manifest are exactly as they were. */
export type DeploymentCommandResult =
  | { applied: true; wrote: boolean; warnings?: DeployWarning[] }
  | { applied: false; refusal: string };

const NO_GAME_DIRECTORY =
  'No game directory found. Set modbench.mods.gameDirectory to your Stock Game Folder or Steam install.';

// MO2 Root-Builder: a mod's root/ contents map to the game root, not Data/. Folder only — no
// vendored MO2 source special-cases a bare `root` file, so one deploys normally.
function hardlinkableWinners(files: FileWinners): DeployLink[] {
  const links: DeployLink[] = [];
  for (const entry of files) {
    if (entry.relativePath.startsWith('root/')) continue;
    links.push({ relativePath: entry.relativePath, source: entry.winner });
  }
  return links;
}

function toCommandResult(outcome: DeployOutcome | PurgeOutcome): DeploymentCommandResult {
  if (!outcome.wrote) {
    return outcome.refusal !== undefined
      ? { applied: false, refusal: outcome.refusal }
      : { applied: true, wrote: false };
  }
  return { applied: true, wrote: true, warnings: outcome.warnings.length > 0 ? outcome.warnings : undefined };
}

const refuse = (err: unknown): DeploymentCommandResult => ({
  applied: false,
  refusal: err instanceof Error ? err.message : String(err),
});

/** `value.files` are the Instance's own field, never a fresh walk, and the game directory it
 *  carries names where the game reads its load order; no `loadOrderFile` leaves the load order
 *  undeployed. */
export function deployMods(
  instanceRoot: string,
  value: Pick<DeployableValue, 'activeProfile' | 'files' | 'gameDirectory'>,
): Promise<DeploymentCommandResult> {
  const { activeProfile, files, gameDirectory } = value;
  if (!gameDirectory) return Promise.resolve({ applied: false, refusal: NO_GAME_DIRECTORY });
  const loadOrder: LoadOrderDeployment[] = gameDirectory.loadOrderFile
    ? [{ source: pluginsFile(instanceRoot, activeProfile), target: gameDirectory.loadOrderFile }]
    : [];
  return deployToGameData(instanceRoot, gameDirectory, hardlinkableWinners(files), loadOrder)
    .then(toCommandResult, refuse);
}

export function purgeMods(
  instanceRoot: string,
  value: Pick<DeployableValue, 'gameDirectory'>,
): Promise<DeploymentCommandResult> {
  if (!value.gameDirectory) return Promise.resolve({ applied: false, refusal: NO_GAME_DIRECTORY });
  return purgeFromGameData(instanceRoot, value.gameDirectory).then(toCommandResult, refuse);
}
