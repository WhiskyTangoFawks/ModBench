import type { MEditClient } from '../client';
import type { RenameEditing } from '../modCommands/renameEntry';
import type { ChangeResult } from '../ports/changeResult';
import { heldTextAt, sameName, spliced, type FileChanges, type HeldTexts } from '../symbolNames/symbolNames';
import { CONTAINER_SCHEMES, type RecordDocumentClient } from '../textDocuments/recordDocument';
import { pluginAddressKey, type PluginAddress } from '../wire/pluginAddress';
import { failureReason, isReadFailed } from '../wire/readFailed';
import { locateCopies } from './recordLocation';
import { stringsAt, type TextSpan } from './sourceText';

/** What a script's references go unread in when mEdit cannot answer. */
export const MEDIT_READS = 'the plugins mEdit reads';

interface ScriptRenameDeps {
  readonly client: Pick<MEditClient, 'getScriptReferences'> & RecordDocumentClient;
  /** A plugin source file's text, unsaved or saved. */
  readonly readText: (path: string) => Promise<string>;
}

type PlannedEdits = { readonly refused: string } | {
  readonly changes: FileChanges;
  readonly cannotFollow: readonly string[];
  /** Each plugin whose plugin source the edits change. */
  readonly touched: readonly PluginAddress[];
};

const copyNamed = ({ formKey, plugin }: { formKey: string; plugin: PluginAddress }): string => `${formKey} in ${plugin.name} (${plugin.origin})`;

async function planEdits({ client, readText }: ScriptRenameDeps, name: string, newName: string, held: HeldTexts): Promise<PlannedEdits> {
  const copies = await client.getScriptReferences(name);
  if (isReadFailed(copies)) return { refused: `${MEDIT_READS}: ${failureReason(copies)}` };
  const { found, leftOut } = await locateCopies(client, copies.filter(({ inPluginSource }) => inPluginSource), async (copy, uri) => {
    if (!CONTAINER_SCHEMES.has(uri.scheme)) throw new Error('its plugin source holds no file of it');
    const text = heldTextAt(held, uri.fsPath) ?? await readText(uri.fsPath);
    const spans = stringsAt(text, copy.formKey, copy.fieldPaths).filter(({ value }) => sameName(value, name));
    if (spans.length < copy.fieldPaths.length) throw new Error(`its plugin source does not name ${name} at ${copy.fieldPaths.join(', ')}`);
    return { plugin: copy.plugin, path: uri.fsPath, text, spans };
  });
  const byPath = new Map<string, { text: string; spans: TextSpan[] }>();
  for (const { path, text, spans } of found) byPath.set(path, { text, spans: [...byPath.get(path)?.spans ?? [], ...spans] });
  return {
    changes: { moves: [], deletions: [], documents: [...byPath].map(([path, { text, spans }]) => ({ path, text: spliced(text, spans, () => newName) })) },
    cannotFollow: [...copies.filter(({ inPluginSource }) => !inPluginSource).map(copyNamed), ...leftOut],
    touched: [...new Map(found.map(({ plugin }) => [pluginAddressKey(plugin), plugin])).values()],
  };
}

/** Carries a Papyrus script's new name to each record that attaches it (ADR-0028): its plugin source changes as edits,
 *  and a copy in a plugin with no plugin source cannot follow (symbols.md, The features, story 7). */
export function scriptRename(deps: ScriptRenameDeps) {
  return async (editing: (touched: readonly PluginAddress[]) => RenameEditing, name: string, newName: string): Promise<ChangeResult> => {
    const planned = await planEdits(deps, name, newName, editing([]).held);
    if ('refused' in planned) return { applied: false, refusal: planned.refused };
    const unapplied = await editing(planned.touched).apply([planned.changes]);
    return unapplied === undefined ? { applied: true, cannotFollow: planned.cannotFollow } : { applied: false, unapplied };
  };
}
