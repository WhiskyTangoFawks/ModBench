// ADR-0013: the system commands that hand mEdit the load order. The Instance loader's value
// arrives as an argument; what comes back is the caller's to report and apply, never pushed to a
// view from here.

import type {
  LoadOrderOutcome, LoadOrderSender, LoadOrderSendOptions, LoadOrderSnapshot, MEditClient,
} from '../client';
import type { GameFolder } from '../instanceAdapter/gameDirectory';
import {
  loadOrderSnapshotOf, type LoadOrderPlugin, type LoadOrderPluginLine,
} from '../instanceLoader/loadOrderSnapshot';
import { gameReleaseForGame } from '../tables/gamePaths';
import { errorMessage } from '../ports/errorMessage';

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

export async function putLoadOrder(
  sender: Pick<LoadOrderSender, 'send'>, instanceRoot: string, value: LoadOrderSource,
  options?: LoadOrderSendOptions,
): Promise<PutLoadOrderResult> {
  const loaded = loadOrderSnapshotOf(value);
  if (!loaded) return { sent: false };
  const snapshot: LoadOrderSnapshot = {
    plugins: loaded.plugins, gameDirectory: loaded.dataFolder, instanceRoot, gameRelease: releaseOf(value.gameName),
  };
  return { sent: true, snapshot, outcome: await sender.send(snapshot, options) };
}

/** ADR-0014: the index is rebuilt before the load order is sent again, so the reconcile that
 *  follows re-indexes everything. A rebuild refused or failed sends nothing. */
export type RefreshResult =
  | { applied: true; loadOrder: PutLoadOrderResult }
  | { applied: false; refusal: string };

export async function refresh(
  client: Pick<MEditClient, 'rebuildIndex'>, sender: Pick<LoadOrderSender, 'send'>, instanceRoot: string,
  value: LoadOrderSource, options?: LoadOrderSendOptions,
): Promise<RefreshResult> {
  const refusal = await rebuildRefusal(client, instanceRoot, releaseOf(value.gameName));
  if (refusal !== undefined) return { applied: false, refusal };
  return { applied: true, loadOrder: await putLoadOrder(sender, instanceRoot, value, options) };
}

// The port gives its reason only through the failure callback, which answers first when it runs.
function rebuildRefusal(
  client: Pick<MEditClient, 'rebuildIndex'>, instanceRoot: string, gameRelease: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    client.rebuildIndex(instanceRoot, (_message, detail) => resolve(detail), gameRelease).then(
      (rebuilt) => resolve(rebuilt ? undefined : 'mEdit did not rebuild the index.'),
      (err: unknown) => resolve(errorMessage(err)),
    );
  });
}
