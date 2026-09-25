// Every write to a profile's plugins.txt. Commands return applied-or-refusal, never throw
// (ADR-0014), and never read the Instance — its watcher is how a write comes back (ADR-0015).

import { foldPath } from '../instanceLoader/fileConflictIndex';
import type { DataFolderPlugins } from '../instanceLoader/loadOrderSnapshot';
import { pluginsFile } from '../instanceAdapter/layout';
import { appendPluginInText, movePluginsInText, parsePlugins, removePluginFromText, setPluginEnabledInText } from '../mo2Codecs/pluginsText';
import { dropIndexIn, type Drop } from '../mo2Codecs/dropIndex';
import { putIfChanged } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

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

/** A gesture over a selection, in one splice: each item landed or refused by name, or the whole
 *  selection refused once when plugins.txt cannot be read or written. */
export type PluginsSelectionResult =
  | { applied: true; outcome: SelectionOutcome<string> }
  | { applied: false; refusal: string };

// Read inside the write lock, so a plugin gone since the view last rendered is refused by name
// while the rest land in the same write.
async function spliceSelection(
  instanceRoot: string, profile: string, names: readonly string[],
  transform: (text: string, found: readonly string[]) => string,
): Promise<PluginsSelectionResult> {
  let landed: string[] = [];
  let refused: ItemRefusal<string>[] = [];
  const outcome = await modifyPlugins(instanceRoot, profile, (text) => {
    const known = new Set(parsePlugins(text).map((entry) => entry.name));
    landed = names.filter((name) => known.has(name));
    refused = names.filter((name) => !known.has(name))
      .map((name) => ({ item: name, reason: `Plugin not found in plugins.txt: ${name}` }));
    return transform(text, landed);
  });
  return outcome.applied ? { applied: true, outcome: { landed, refused } } : outcome;
}

/** `modbench.plugin.enable` / `modbench.plugin.disable`, over the whole selection in one splice
 *  (commands.md, "A selection is one gesture") — the menu, the key and the check box all reach
 *  this same core. */
export function setPluginsEnabled(
  instanceRoot: string, profile: string, pluginNames: readonly string[], enabled: boolean,
): Promise<PluginsSelectionResult> {
  return spliceSelection(instanceRoot, profile, pluginNames, (text, found) =>
    found.reduce((acc, name) => setPluginEnabledInText(acc, name, enabled), text));
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

// `inData` is presence only, never a source of added lines.
function pluginLinesDelta(
  listed: readonly string[],
  provided: ReadonlyMap<string, string>,
  inData: ReadonlySet<string>,
): PluginLinesDelta {
  const listedFolded = new Set(listed.map(foldPath));
  const added = [...provided]
    .filter(([folded]) => !listedFolded.has(folded))
    .map(([, real]) => real)
    .sort((a, b) => foldPath(a).localeCompare(foldPath(b)));
  const dropped = listed.filter((name) => !provided.has(foldPath(name)) && !inData.has(foldPath(name)));
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
  inData: DataFolderPlugins, implicitMasters: ImplicitMasterSource,
): Promise<PluginSyncResult> {
  // Without the Data folder's listing or the implicit masters, a line for a Data plugin is
  // dropped and a mod's copy of a vanilla master earns one (update-load-order-file, Refusals).
  if (inData.kind === 'unresolved') return { applied: false, refusal: 'the game folder is not found' };
  if (inData.kind === 'unreadable') {
    return { applied: false, refusal: `the game's Data folder cannot be listed: ${inData.reason}` };
  }
  let addable: ReadonlyMap<string, string>;
  try {
    const implicit = await implicitMasters();
    if (implicit === undefined) {
      return { applied: false, refusal: 'mEdit cannot say which plugins the game loads with no line' };
    }
    // An implicit master is left out: the tree gives it a row of its own, never from a line, so
    // a mod's copy of one must not earn a line.
    const implicitFolded = new Set(implicit.map(foldPath));
    addable = new Map([...provided].filter(([folded]) => !implicitFolded.has(folded)));
  } catch (err) {
    return refuse(err);
  }
  const inDataNames = inData.names;

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
