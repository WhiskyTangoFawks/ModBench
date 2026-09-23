// Every write to a profile's plugins.txt. Commands return applied-or-refusal, never throw
// (ADR-0014), and never read the Instance — its watcher is how a write comes back (ADR-0015).

import { foldPath } from '../instanceLoader/fileConflictIndex';
import type { DataFolderPlugins } from '../instanceLoader/loadOrderSnapshot';
import { pluginsFile } from '../instanceAdapter/layout';
import { appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText } from '../mo2Codecs/pluginsText';
import { dropIndexIn, type Drop } from '../mo2Codecs/dropIndex';
import { putIfChanged } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the plugins.txt watcher. */
export type PluginsCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

async function modifyPlugins(
  instanceRoot: string, profile: string, edit: (text: string) => string,
): Promise<PluginsCommandResult> {
  try {
    // Unchanged text is not written: for `syncPlugins` that is the difference between a
    // loop that settles and one that does not.
    const { wrote } = await putIfChanged(pluginsFile(instanceRoot, profile), edit);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
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

/** Where a drag landed in the Plugins tree. Re-exported so the view names the drop without
 *  naming the codec that settles it into an index. */
export type { Drop as PluginsDrop } from '../mo2Codecs/dropIndex';

export function reorderPlugins(
  instanceRoot: string, profile: string, pluginNames: string[], drop: Drop,
): Promise<PluginsCommandResult> {
  // Settled against the text this splice is about to rewrite, so a tree a generation behind
  // plugins.txt cannot land the block at a stale index.
  return modifyPlugins(instanceRoot, profile, (text) =>
    movePluginsInText(text, pluginNames, dropIndexIn(parsePlugins(text).map((p) => p.name), pluginNames, drop)));
}

/** The New Plugin gesture's line, enabled, at the winning end; the file already exists on disk
 *  by the time this runs (ADR-0007). Refuses a name that already has a line. */
export function appendPlugin(
  instanceRoot: string, profile: string, pluginName: string,
): Promise<PluginsCommandResult> {
  return modifyPlugins(instanceRoot, profile, (text) => appendPluginInText(text, pluginName));
}

interface PluginLinesDelta {
  // Real on-disk names whose line is added, disabled, ascending case-folded.
  added: string[];
  // plugins.txt names (as written) whose line is dropped.
  dropped: string[];
}

export type PluginSyncResult =
  | { applied: true; wrote: boolean; added: string[]; dropped: string[] }
  | { applied: false; refusal: string };

// `inData` is presence only, never a source of added lines; `undefined` — an unresolved game
// directory — makes presence unknowable, so nothing is dropped.
function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  inData: ReadonlySet<string> | undefined,
): PluginLinesDelta {
  const listedFolded = new Set(listed.map(foldPath));
  const added = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const dropped = inData === undefined
    ? []
    : listed.filter((name) => !provided.has(foldPath(name)) && !inData.has(foldPath(name)));
  return { added, dropped };
}

/** Answers the plugins this install loads with no plugins.txt line, or `undefined` when the
 *  backend that knows them cannot be reached. Only the backend can answer it: deriving the set
 *  here would mean parsing plugin headers (ADR-0016). */
export type ImplicitMasterSource = () => Promise<readonly string[] | undefined>;

/** `modbench.plugin.sync`: plugins.txt is the inventory the Plugins tree reads, so when disk
 *  disagrees the file is updated. `provided` is the value's winners and `inData` its Data-folder
 *  presence, both handed in — this walks nothing. */
export async function syncPlugins(
  instanceRoot: string, profile: string, provided: ReadonlyMap<string, string>,
  inData: DataFolderPlugins, implicitMasters: ImplicitMasterSource, log: (msg: string) => void,
): Promise<PluginSyncResult> {
  let addable: ReadonlyMap<string, string>;
  try {
    const implicit = await implicitMasters();
    // Without them every verdict is a guess: a mod's copy of a vanilla master earns a line, and
    // a line for one is dropped. So the run does nothing, as an unresolved game directory
    // already does for dropping.
    if (implicit === undefined) {
      log('[plugins] the implicit masters are unknown — adding and dropping nothing this run');
      return { applied: true, wrote: false, added: [], dropped: [] };
    }
    // A folder that resolved and could not be read leaves every verdict a guess the same way, so
    // the run refuses with the read's own reason rather than adding against half an answer.
    if (inData.kind === 'unreadable') return { applied: false, refusal: inData.reason };
    // An implicit master is left out: the tree gives it a row of its own, never from a line, so
    // a mod's copy of one must not earn a line.
    const implicitFolded = new Set(implicit.map(foldPath));
    addable = new Map([...provided].filter(([folded]) => !implicitFolded.has(folded)));
  } catch (err) {
    return refuse(err);
  }
  const inDataNames = inData.kind === 'listed' ? inData.names : undefined;

  let delta: PluginLinesDelta = { added: [], dropped: [] };
  const result = await modifyPlugins(instanceRoot, profile, (text) => {
    // The delta is computed inside the write chain, from the text about to be spliced, so two
    // overlapping runs can neither add a line twice nor drop one the other just wrote.
    delta = pluginLinesDelta(parsePlugins(text).map((e) => e.name), addable, inDataNames);
    let out = text;
    for (const name of delta.dropped) out = removePluginFromText(out, name);
    for (const name of delta.added) out = appendPluginInText(out, name, false);
    return out;
  });
  return result.applied ? { ...result, ...delta } : result;
}
