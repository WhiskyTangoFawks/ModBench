// Put load order (ADR-0013) and refresh. What comes back is the caller's to report and apply,
// never pushed to a view from here.

import type { LoadOrderOutcome, LoadOrderSnapshot, MEditClient } from '../client';

/** The game the instance is for. */
export interface InstanceGame {
  /** As the mod manager's configuration names it. */
  readonly gameName: string;
  /** Mutagen's release of that game; undefined when the tables hold none for it. */
  readonly gameRelease: string | undefined;
}

/** The slice of the instance value put load order sends. */
export interface LoadOrderSource extends InstanceGame {
  readonly loadOrderSnapshot:
    | (Pick<LoadOrderSnapshot, 'plugins' | 'active' | 'loadedWithNoLine'> & { readonly dataFolder: string })
    | { readonly refusal: string }
    | undefined;
}

/** Nothing is sent without a game folder found: there is no Data folder to key the load order on.
 *  A refusal is the loader's, to tell once: a partial snapshot would unregister what it left out. */
export type PutLoadOrderResult =
  | { sent: false; refusal?: string }
  | { sent: true; snapshot: LoadOrderSnapshot; outcome: LoadOrderOutcome };

// A game with no release is sent as the mod manager names it rather than a guess: the backend then
// rejects it visibly instead of quietly answering about the wrong game.
export const releaseOf = (game: InstanceGame): string => game.gameRelease ?? game.gameName;

export async function putLoadOrder(
  client: Pick<MEditClient, 'sendLoadOrder'>, instanceRoot: string, value: LoadOrderSource,
): Promise<PutLoadOrderResult> {
  if (!value.loadOrderSnapshot) return { sent: false };
  if ('refusal' in value.loadOrderSnapshot) return { sent: false, refusal: value.loadOrderSnapshot.refusal };
  const { plugins, active, loadedWithNoLine, dataFolder } = value.loadOrderSnapshot;
  const snapshot: LoadOrderSnapshot = {
    plugins, active, loadedWithNoLine, gameDirectory: dataFolder, instanceRoot, gameRelease: releaseOf(value),
  };
  return { sent: true, snapshot, outcome: await client.sendLoadOrder(snapshot) };
}

/** The rebuild of commands.md's `refresh`: mEdit reads every plugin again against the load order
 *  it holds, and nothing is sent. Held-elsewhere is its own refusal (ADR-0010). */
export type RefreshResult =
  | { applied: true }
  | { applied: false; heldElsewhere: true }
  | { applied: false; heldElsewhere: false; refusal: string };
