// Put load order (ADR-0013) and refresh. What comes back is the caller's to report and apply,
// never pushed to a view from here.

import { samePluginAddress } from '../wire/pluginAddress';
import type { LoadOrderOutcome, LoadOrderSnapshot, MEditClient, PluginAddress } from '../client';

/** What the loader read of the instance for put load order to send. */
export type LoadOrderSource =
  | (Pick<LoadOrderSnapshot, 'plugins' | 'active' | 'loadedWithNoLine' | 'stringsFiles' | 'places' | 'gameRelease'> & ArchivesByPlugin & { readonly dataFolder: string })
  | { readonly refusal: string }
  | undefined;

// The archives the INIs list, then each plugin's with it, as the loader read them, before the order the game loads the plugins in is known.
interface ArchivesByPlugin {
  readonly listedArchives: LoadOrderSnapshot['archives'];
  readonly archivesByPlugin: readonly (PluginAddress & { readonly archives: LoadOrderSnapshot['archives'] })[];
}

/** The order the game loads the snapshot's active plugins in, which the loader cannot know: it takes
 *  a blueprint plugin's place from the header facts Editing supplies (ADR-0013). */
export type InGameOrder = (snapshot: Pick<LoadOrderSnapshot, 'active' | 'loadedWithNoLine' | 'gameRelease'>) => PluginAddress[];

/** Nothing is sent without a game folder found: there is no Data folder to key the load order on.
 *  A refusal is the loader's, to tell once: a partial snapshot would unregister what it left out. */
export type PutLoadOrderResult =
  | { sent: false; refusal?: string }
  | { sent: true; snapshot: LoadOrderSnapshot; outcome: LoadOrderOutcome };

/** A snapshot `changed` answers false for is sent no more (ADR-0013). */
export async function putLoadOrder(
  client: Pick<MEditClient, 'sendLoadOrder'>, instanceRoot: string, source: LoadOrderSource, stringsLanguage: string | undefined,
  inGameOrder: InGameOrder, changed: (snapshot: LoadOrderSnapshot) => boolean = () => true,
): Promise<PutLoadOrderResult> {
  if (!source) return { sent: false };
  if ('refusal' in source) return { sent: false, refusal: source.refusal };
  if (stringsLanguage === undefined) throw new Error('The strings language has no value: package.json declares its default.');
  const { plugins, loadedWithNoLine, stringsFiles, places, gameRelease, dataFolder } = source;
  const active = inGameOrder(source);
  const archives = archivesOfPlugins(source, active);
  const snapshot: LoadOrderSnapshot = {
    plugins, active, loadedWithNoLine, archives, stringsFiles, places, dataFolder, instanceRoot, gameRelease, stringsLanguage,
  };
  if (!changed(snapshot)) return { sent: false };
  return { sent: true, snapshot, outcome: await client.sendLoadOrder(snapshot) };
}

/** The rebuild of commands.md's `refresh`: mEdit reads every plugin again against the load order
 *  it holds, and nothing is sent. Held-elsewhere is its own refusal (ADR-0010). */
export type RefreshResult =
  | { applied: true }
  | { applied: false; heldElsewhere: true }
  | { applied: false; heldElsewhere: false; refusal: string };

const archivesOfPlugins = ({ listedArchives, archivesByPlugin }: ArchivesByPlugin, active: readonly PluginAddress[]): LoadOrderSnapshot['archives'] => {
  const inOrder = [...listedArchives, ...active.flatMap((plugin) => archivesByPlugin.find((own) => samePluginAddress(own, plugin))?.archives ?? [])];
  return inOrder.filter(({ path }, index) => inOrder.findIndex((first) => first.path === path) === index);
};
