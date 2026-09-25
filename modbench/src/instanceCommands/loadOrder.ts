// ADR-0013: the system commands that hand mEdit the load order. The Instance loader's value
// arrives as an argument; what comes back is the caller's to report and apply, never pushed to a
// view from here.

import type {
  LoadOrderOutcome, LoadOrderSender, LoadOrderSnapshot, MEditClient,
} from '../client';
import type { GameFolder } from '../instanceAdapter/gameDirectory';
import {
  loadOrderSnapshotOf, type LoadOrderPlugin, type LoadOrderPluginLine,
} from '../instanceLoader/loadOrderSnapshot';
import { gameReleaseForGame } from '../tables/gamePaths';

/** The slice of the instance value a load order is built from. */
export interface LoadOrderSource {
  readonly plugins: readonly (LoadOrderPlugin | LoadOrderPluginLine)[];
  readonly gameFolder: GameFolder;
  /** MO2's own name for the game. */
  readonly gameName: string;
}

/** Nothing is sent without a game folder found: there is no Data folder to key the load order on. */
export type PutLoadOrderResult =
  | { sent: false }
  | { sent: true; snapshot: LoadOrderSnapshot; outcome: LoadOrderOutcome };

// A release the table can't translate is sent as MO2's own spelling rather than a guess: the
// backend then rejects it visibly instead of quietly answering about the wrong game.
const releaseOf = (gameName: string): string => gameReleaseForGame(gameName) ?? gameName;

function snapshotOf(instanceRoot: string, value: LoadOrderSource): LoadOrderSnapshot | undefined {
  const loaded = loadOrderSnapshotOf(value);
  if (!loaded) return undefined;
  return {
    plugins: loaded.plugins, gameDirectory: loaded.dataFolder, instanceRoot, gameRelease: releaseOf(value.gameName),
  };
}

export async function putLoadOrder(
  sender: Pick<LoadOrderSender, 'send'>, instanceRoot: string, value: LoadOrderSource,
): Promise<PutLoadOrderResult> {
  const snapshot = snapshotOf(instanceRoot, value);
  if (!snapshot) return { sent: false };
  return { sent: true, snapshot, outcome: await sender.send(snapshot) };
}

/** update-load-order-file: the load order is put on change. False with no game folder found, since
 *  there is then nothing to put. */
export function loadOrderChanged(
  sender: Pick<LoadOrderSender, 'alreadySent'>, instanceRoot: string, value: LoadOrderSource,
): boolean {
  const snapshot = snapshotOf(instanceRoot, value);
  return snapshot !== undefined && !sender.alreadySent(snapshot);
}

/** load-instance, refresh: mEdit rebuilds the index and reads every plugin again against the load
 *  order it holds; nothing is sent. ADR-0009 invariant 5: held-elsewhere is a refusal apart from
 *  every other failure. */
export type RefreshResult =
  | { applied: true }
  | { applied: false; heldElsewhere: true }
  | { applied: false; heldElsewhere: false; refusal: string };

export async function refresh(
  client: Pick<MEditClient, 'rebuildIndex'>, instanceRoot: string, gameName: string,
): Promise<RefreshResult> {
  const outcome = await client.rebuildIndex(instanceRoot, releaseOf(gameName));
  if (outcome.rebuilt) return { applied: true };
  return outcome.heldElsewhere
    ? { applied: false, heldElsewhere: true }
    : { applied: false, heldElsewhere: false, refusal: outcome.detail };
}
