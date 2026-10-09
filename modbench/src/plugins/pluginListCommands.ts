import * as vscode from 'vscode';
import { isRefused, type MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import {
  PluginsTreeProvider, type PluginListNode, type PluginsTreeNode,
} from './PluginsTreeProvider';
import {
  PLUGIN_ROW_KINDS, RECORD_ROW_KINDS, PLUGINS_KEY_ARGS, onlySelected,
} from './gestureEntry';
import type { RowOf } from '../drivingLib/gestureEntry';
import { viewCopyValueText } from '../drivingLib/copyValue';
import { placeFolder, pluginPlaces } from './pluginPlaces';
import { creatablePluginExtensionsOf, pluginNameRefusal } from './pluginName';
import type { Reporter } from '../ports/reporter';
import { registerSortDirectionToggle } from '../drivingLib/sortDirectionToggle';
import { errorMessage } from '../ports/errorMessage';
import { recordLabel } from '../wire/recordLabel';

export function registerPluginSortCommands(pluginsTree: Pick<PluginsTreeProvider, 'setViewDirection'>): vscode.Disposable[] {
  return registerSortDirectionToggle('plugin', pluginsTree);
}

// The row's own reveal-in-Explorer gesture — an instance-scoped fact (which plugin
// wins, where its file lives), so it reads through the tree rather than a disk lookup of its own.
export function registerRevealInExplorerCommand(
  pluginsTree: Pick<PluginsTreeProvider, 'resolvePluginPath'>, reporter: Reporter,
  viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.reveal', async (clicked: PluginListNode | undefined) => {
    const node = clicked ?? onlySelected(viewSelection(), ...PLUGIN_ROW_KINDS);
    if (node?.kind !== 'plugin' && node?.kind !== 'implicitMaster') return;
    const name = node.kind === 'plugin' ? node.plugin.name : node.name;
    const filePath = await pluginsTree.resolvePluginPath(node);
    if (!filePath) {
      const why = node.kind === 'plugin' ? 'no mod or Overwrite holds this file' : 'the game folder was not found';
      // ADR-0019.
      reporter.report('error', `Could not resolve a file location for "${name}" — ${why}.`);
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
      reporter.report('error', `Failed to reveal "${name}" in Explorer.`, errorMessage(err));
    }
  });
}

const COPIED_KINDS = [...PLUGIN_ROW_KINDS, ...RECORD_ROW_KINDS] as const;

type CopiedRow = RowOf<PluginsTreeNode, typeof COPIED_KINDS[number]>;

// editor.md, The header: `EditorID [FormKey]`, or the FormKey alone when there is no EditorID.
function copyValueLine(row: CopiedRow): string {
  if (row.kind === 'plugin') return row.plugin.name;
  if (row.kind === 'implicitMaster') return row.name;
  const { formKey, editorId } = row.kind === 'record'
    ? { formKey: row.record.formKey, editorId: row.record.editorId ?? undefined }
    : row;
  return recordLabel(editorId, formKey);
}

/** Plugins' own text for the catalog's one copy value id (plugins.md, Menus and keys, story 5).
 *  `undefined` unless `clicked` is a Plugins row or the Plugins key's args, so another view's
 *  invocation defers. */
export const pluginsCopyValueText = (viewSelection: () => readonly PluginsTreeNode[]) =>
  viewCopyValueText<PluginsTreeNode, typeof COPIED_KINDS[number]>(PLUGINS_KEY_ARGS.view, COPIED_KINDS, copyValueLine, viewSelection);

async function promptPluginName(
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>, reporter: Reporter,
): Promise<string | undefined> {
  const creatableExtensions = await creatablePluginExtensionsOf(client, reporter);
  if (creatableExtensions === undefined) return undefined;
  return vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: (name) => pluginNameRefusal(name, creatableExtensions),
  });
}

function lostPlace(origin: string, lost: 'gone' | 'disabled' | 'unread'): string {
  if (lost === 'unread') return 'Overwrite has no folder yet';
  return `The mod "${origin}" ${lost === 'gone' ? 'is gone' : 'was disabled'}`;
}

// create-plugin: the file is the whole gesture. Its plugins.txt line is plugin sync's, once the
// watch sees the file, so nothing here writes that line or refreshes a view.
export function registerCreatePluginCommand(
  client: Pick<MEditClient, 'createPlugin' | 'getCreatablePluginExtensions'>,
  instance: Pick<Instance, 'value'>,
  reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.create', async () => {
    const name = await promptPluginName(client, reporter);
    if (!name) return;

    const places = pluginPlaces(instance.value, name);
    if (places.length === 0) {
      reporter.report('error', `Overwrite and every enabled mod already hold "${name}".`);
      return;
    }
    const picked = await vscode.window.showQuickPick(places, { placeHolder: 'Where should the new plugin live?' });
    if (!picked) return;

    const place = placeFolder(instance.value, picked.origin);
    if ('lost' in place) {
      reporter.report('error', `${lostPlace(picked.origin, place.lost)}, so "${name}" was not created.`);
      return;
    }

    const result = await client.createPlugin({ name, origin: picked.origin }, place.folder);
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    reporter.landed(`Created "${result.name}" in ${picked.label}.`);
  });
}
