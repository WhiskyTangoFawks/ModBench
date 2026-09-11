// Every write to a profile's plugins.txt. Commands return applied-or-refusal, never throw
// (ADR-0014), and never read the Instance — its watcher is how a write comes back (ADR-0015).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { foldPath } from '../fileConflictIndex';
import { isPluginFile } from '../pluginFile';
import { pluginsFile } from '../mo2/layout';
import { appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText } from '../mo2/pluginsText';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the plugins.txt watcher. */
export type PluginsCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

// Serialized: two commands read-modify-writing at once would each splice a stale generation of
// the text. The chain can never go dead — the task below returns its failures and never rejects.
let writes: Promise<unknown> = Promise.resolve();

function modifyPlugins(
  instanceRoot: string, profile: string, edit: (text: string) => string,
): Promise<PluginsCommandResult> {
  const task = writes.then(async (): Promise<PluginsCommandResult> => {
    try {
      const path = pluginsFile(instanceRoot, profile);
      const before = await readFile(path, 'utf8');
      const after = edit(before);
      // Unchanged text is not written: for `reconcilePlugins` that is the difference between a
      // loop that settles and one that does not.
      if (after === before) return { applied: true, wrote: false };
      await writeFile(path, after);
      return { applied: true, wrote: true };
    } catch (err) {
      return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
    }
  });
  writes = task;
  return task;
}

/** Refuses a name with no entry line: there is no marker to toggle, and a silent no-op would
 *  leave the gesture looking applied. */
export function setPluginEnabled(
  instanceRoot: string, profile: string, pluginName: string, enabled: boolean,
): Promise<PluginsCommandResult> {
  return modifyPlugins(instanceRoot, profile, (text) => {
    if (!parsePlugins(text).some((entry) => entry.name === pluginName)) {
      throw new Error(`Plugin not found in plugins.txt: ${pluginName}`);
    }
    return setPluginEnabledInText(text, pluginName, enabled);
  });
}

/** `toIndex` counts entries with the moved lines already removed. Refuses if a name has no
 *  entry line. */
export function reorderPlugins(
  instanceRoot: string, profile: string, pluginNames: string[], toIndex: number,
): Promise<PluginsCommandResult> {
  return modifyPlugins(instanceRoot, profile, (text) => movePluginsInText(text, pluginNames, toIndex));
}

/** The New Plugin gesture's line, enabled, at the winning end; the file already exists on disk
 *  by the time this runs (ADR-0007). Refuses a name that already has a line. */
export function appendPlugin(
  instanceRoot: string, profile: string, pluginName: string,
): Promise<PluginsCommandResult> {
  return modifyPlugins(instanceRoot, profile, (text) => appendPluginInText(text, pluginName));
}

export interface PluginLinesDelta {
  /** Real on-disk names to append, disabled, ascending case-folded. */
  append: string[];
  /** plugins.txt names (as written) whose line goes. */
  prune: string[];
}

export type PluginsReconcileResult =
  | { applied: true; wrote: boolean; append: string[]; prune: string[] }
  | { applied: false; refusal: string };

/** `inData` is presence only, never an append source; `undefined` — an unresolved game
 *  directory — makes presence unknowable, so nothing is pruned. */
export function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  inData: ReadonlySet<string> | undefined,
): PluginLinesDelta {
  const listedFolded = new Set(listed.map(foldPath));
  const append = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const prune = inData === undefined
    ? []
    : listed.filter((name) => !provided.has(foldPath(name)) && !inData.has(foldPath(name)));
  return { append, prune };
}

// A `.mohidden` file fails the extension test, so MO2's hide-by-rename reads as absent.
async function rootLevelPlugins(folder: string): Promise<Map<string, string>> {
  const dirents = await readdir(folder, { withFileTypes: true });
  return new Map(dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => [foldPath(d.name), d.name]));
}

/** Answers the plugins this install loads with no plugins.txt line, or `undefined` when the
 *  backend that knows them cannot be reached. Only the backend can answer it: deriving the set
 *  here would mean parsing plugin headers (ADR-0016). */
export type ImplicitMasterSource = () => Promise<readonly string[] | undefined>;

/** plugins.txt is the complete inventory the Plugins tree reads, so when disk disagrees the file
 *  is updated (docs/specs/plugins.md). `provided` is the Instance value's own winners
 *  (ADR-0015): this walks neither mods/ nor overwrite/. A failure to enumerate the Data folder
 *  refuses the whole run — an errored walk must never read as "everything vanished". */
export async function reconcilePlugins(
  instanceRoot: string, profile: string, provided: ReadonlyMap<string, string>,
  dataFolder: string | undefined, implicitMasters: ImplicitMasterSource, log: (msg: string) => void,
): Promise<PluginsReconcileResult> {
  let appendable: ReadonlyMap<string, string>;
  let inData: ReadonlySet<string> | undefined;
  try {
    const implicit = await implicitMasters();
    // Without them every verdict is a guess: a mod's copy of a vanilla master earns a line, and
    // a line for one is pruned. So the run does nothing, as an unresolved game directory
    // already does for pruning.
    if (implicit === undefined) {
      log('[plugins] the implicit masters are unknown — appending and pruning nothing this run');
      return { applied: true, wrote: false, append: [], prune: [] };
    }
    inData = dataFolder === undefined ? undefined : new Set((await rootLevelPlugins(dataFolder)).keys());
    // An implicit master is left out: the tree gives it a row of its own, never from a line, so
    // a mod's copy of one must not earn a line.
    const implicitFolded = new Set(implicit.map(foldPath));
    appendable = new Map([...provided].filter(([folded]) => !implicitFolded.has(folded)));
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }

  let delta: PluginLinesDelta = { append: [], prune: [] };
  const result = await modifyPlugins(instanceRoot, profile, (text) => {
    // The delta is computed inside the write chain, from the text about to be spliced, so two
    // overlapping runs can neither double-append nor prune a line the other just wrote.
    delta = pluginLinesDelta(parsePlugins(text).map((e) => e.name), appendable, inData);
    let out = text;
    for (const name of delta.prune) out = removePluginFromText(out, name);
    for (const name of delta.append) out = appendPluginInText(out, name, false);
    return out;
  });
  return result.applied ? { ...result, ...delta } : result;
}
