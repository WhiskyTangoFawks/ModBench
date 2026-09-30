// ADR-0013: the system commands that hand mEdit the load order. The Instance loader's value
// arrives as an argument; what comes back is the caller's to report and apply, never pushed to a
// view from here.

import type {
  LoadOrderOutcome, LoadOrderSender, LoadOrderSnapshot, MEditClient,
} from '../client';
import type { GameFolder } from '../instanceAdapter/instanceAdapter';
import {
  loadOrderSnapshotOf, type LoadOrderPlugin, type LoadOrderPluginLine,
} from '../instanceLoader/loadOrderSnapshot';

/** The game the instance is for. */
export interface InstanceGame {
  /** As the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
}

/** The slice of the instance value a load order is built from. */
export interface LoadOrderSource extends InstanceGame {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
}

/** Nothing is sent without a game folder found: there is no Data folder to key the load order on. */
export type PutLoadOrderResult =
  | { sent: false }
  | { sent: true; snapshot: LoadOrderSnapshot; outcome: LoadOrderOutcome };

// A game with no release is sent as the mod manager names it rather than a guess: the backend then
// rejects it visibly instead of quietly answering about the wrong game.
const releaseOf = (game: InstanceGame): string => game.gameRelease ?? game.gameName;

function snapshotOf(instanceRoot: string, value: LoadOrderSource): LoadOrderSnapshot | undefined {
  const loaded = loadOrderSnapshotOf(value);
  if (!loaded) return undefined;
  return {
    plugins: loaded.plugins, gameDirectory: loaded.dataFolder, instanceRoot, gameRelease: releaseOf(value),
  };
}

export async function putLoadOrder(
  sender: Pick<LoadOrderSender, 'send'>, instanceRoot: string, value: LoadOrderSource,
): Promise<PutLoadOrderResult> {
  const snapshot = snapshotOf(instanceRoot, value);
  if (!snapshot) return { sent: false };
  return { sent: true, snapshot, outcome: await sender.send(snapshot) };
}

/** commands.md, `refresh`: mEdit rebuilds the index and reads every plugin again against the
 *  load order it holds; nothing is sent. ADR-0009 invariant 5: held-elsewhere is a refusal apart
 *  from every other failure. */
export type RefreshResult =
  | { applied: true }
  | { applied: false; heldElsewhere: true }
  | { applied: false; heldElsewhere: false; refusal: string };

export async function refresh(
  client: Pick<MEditClient, 'rebuildIndex'>, instanceRoot: string, game: InstanceGame,
): Promise<RefreshResult> {
  const outcome = await client.rebuildIndex(instanceRoot, releaseOf(game));
  if (outcome.rebuilt) return { applied: true };
  return outcome.heldElsewhere
    ? { applied: false, heldElsewhere: true }
    : { applied: false, heldElsewhere: false, refusal: outcome.detail };
}
