// Put load order (ADR-0013) and refresh. What comes back is the caller's to report and apply,
// never pushed to a view from here.

import type { LoadOrderOutcome, LoadOrderSnapshot, MEditClient } from '../client';

/** What the loader read of the instance for put load order to send. */
export type LoadOrderSource =
  | (Pick<LoadOrderSnapshot, 'plugins' | 'active' | 'loadedWithNoLine' | 'archives' | 'stringsFiles' | 'places' | 'gameRelease'> & { readonly dataFolder: string })
  | { readonly refusal: string }
  | undefined;

/** Nothing is sent without a game folder found: there is no Data folder to key the load order on.
 *  A refusal is the loader's, to tell once: a partial snapshot would unregister what it left out. */
export type PutLoadOrderResult =
  | { sent: false; refusal?: string }
  | { sent: true; snapshot: LoadOrderSnapshot; outcome: LoadOrderOutcome };

export async function putLoadOrder(
  client: Pick<MEditClient, 'sendLoadOrder'>, instanceRoot: string, source: LoadOrderSource, stringsLanguage: string | undefined,
): Promise<PutLoadOrderResult> {
  if (!source) return { sent: false };
  if ('refusal' in source) return { sent: false, refusal: source.refusal };
  if (stringsLanguage === undefined) throw new Error('The strings language has no value: package.json declares its default.');
  const { plugins, active, loadedWithNoLine, archives, stringsFiles, places, gameRelease, dataFolder } = source;
  const snapshot: LoadOrderSnapshot = {
    plugins, active, loadedWithNoLine, archives, stringsFiles, places, dataFolder, instanceRoot, gameRelease, stringsLanguage,
  };
  return { sent: true, snapshot, outcome: await client.sendLoadOrder(snapshot) };
}

/** The rebuild of commands.md's `refresh`: mEdit reads every plugin again against the load order
 *  it holds, and nothing is sent. Held-elsewhere is its own refusal (ADR-0010). */
export type RefreshResult =
  | { applied: true }
  | { applied: false; heldElsewhere: true }
  | { applied: false; heldElsewhere: false; refusal: string };
