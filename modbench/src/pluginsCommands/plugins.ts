// Every write to a profile's plugins.txt. Commands return applied-or-refusal, never throw
// (ADR-0014), and never read the Instance — its watcher is how a write comes back (ADR-0015).

import { foldPath } from '../instance/fileConflictIndex';
import type { DataFolderPlugins } from '../instance/loadOrderSnapshot';
import { pluginsFile } from '../mo2Files/layout';
import { appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText } from '../mo2Codecs/pluginsText';
import { putIfChanged } from '../mo2Files/files';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the plugins.txt watcher. */
export type PluginsCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

async function modifyPlugins(
  instanceRoot: string, profile: string, edit: (text: string) => string,
): Promise<PluginsCommandResult> {
  try {
    // Unchanged text is not written: for `reconcilePlugins` that is the difference between a
    // loop that settles and one that does not.
    const { wrote } = await putIfChanged(pluginsFile(instanceRoot, profile), edit);
    return { applied: true, wrote };
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
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

/** Answers the plugins this install loads with no plugins.txt line, or `undefined` when the
 *  backend that knows them cannot be reached. Only the backend can answer it: deriving the set
 *  here would mean parsing plugin headers (ADR-0016). */
export type ImplicitMasterSource = () => Promise<readonly string[] | undefined>;

/** plugins.txt is the inventory the Plugins tree reads, so when disk disagrees the file is
 *  updated (docs/specs/plugins.md). `provided` is the value's winners and `inData` its
 *  Data-folder presence, both handed in — this walks nothing. */
export async function reconcilePlugins(
  instanceRoot: string, profile: string, provided: ReadonlyMap<string, string>,
  inData: DataFolderPlugins, implicitMasters: ImplicitMasterSource, log: (msg: string) => void,
): Promise<PluginsReconcileResult> {
  let appendable: ReadonlyMap<string, string>;
  try {
    const implicit = await implicitMasters();
    // Without them every verdict is a guess: a mod's copy of a vanilla master earns a line, and
    // a line for one is pruned. So the run does nothing, as an unresolved game directory
    // already does for pruning.
    if (implicit === undefined) {
      log('[plugins] the implicit masters are unknown — appending and pruning nothing this run');
      return { applied: true, wrote: false, append: [], prune: [] };
    }
    // A folder that resolved and could not be read leaves every verdict a guess the same way, so
    // the run refuses with the read's own reason rather than appending against half an answer.
    if (inData.kind === 'unreadable') return { applied: false, refusal: inData.reason };
    // An implicit master is left out: the tree gives it a row of its own, never from a line, so
    // a mod's copy of one must not earn a line.
    const implicitFolded = new Set(implicit.map(foldPath));
    appendable = new Map([...provided].filter(([folded]) => !implicitFolded.has(folded)));
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
  const inDataNames = inData.kind === 'listed' ? inData.names : undefined;

  let delta: PluginLinesDelta = { append: [], prune: [] };
  const result = await modifyPlugins(instanceRoot, profile, (text) => {
    // The delta is computed inside the write chain, from the text about to be spliced, so two
    // overlapping runs can neither double-append nor prune a line the other just wrote.
    delta = pluginLinesDelta(parsePlugins(text).map((e) => e.name), appendable, inDataNames);
    let out = text;
    for (const name of delta.prune) out = removePluginFromText(out, name);
    for (const name of delta.append) out = appendPluginInText(out, name, false);
    return out;
  });
  return result.applied ? { ...result, ...delta } : result;
}
