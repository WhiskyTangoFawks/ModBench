import * as vscode from 'vscode';
import { isRefused, type MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import {
  ImplicitMasterNode, PluginNode, PluginsTreeProvider, type PluginListNode, type PluginsTreeNode, type SortDirection,
} from './PluginsTreeProvider';
import {
  PLUGIN_ROW_KINDS, RECORD_ROW_KINDS, isPluginsKeyArgs, onlySelected, pluginsGestureEntry, selectionArgument, type GestureEntry,
} from './gestureEntry';
import { CellNode, PlacedNode, RecordNode, WorldspaceNode } from './PluginTreeProvider';
import { placeFolder, pluginPlaces } from './pluginPlaces';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

/** The Plugins view's direction writes no file, so it lives with the view it flips. It starts
 *  losing at the top on each activation, and the context key, which outlives an extension host
 *  restart, is told so. */
export function registerPluginSortCommands(pluginsTree: Pick<PluginsTreeProvider, 'setViewDirection'>): vscode.Disposable[] {
  const show = (direction: SortDirection) => {
    pluginsTree.setViewDirection(direction);
    void vscode.commands.executeCommand('setContext', 'modbench.plugin.winningAtTop', direction === 'winningAtTop');
  };
  void vscode.commands.executeCommand('setContext', 'modbench.plugin.winningAtTop', false);
  return [
    vscode.commands.registerCommand('modbench.plugin.sortWinningAtTop', () => show('winningAtTop')),
    vscode.commands.registerCommand('modbench.plugin.sortLosingAtTop', () => show('losingAtTop')),
  ];
}

// The row's own reveal-in-Explorer gesture — an MO2-instance-scoped fact (which plugin
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
      // ADR-0019: an explicit user action failed — notify + log, never a silent no-op.
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

type CopiedRow = PluginNode | ImplicitMasterNode | RecordNode | WorldspaceNode | CellNode | PlacedNode;

function isCopiedRow(value: unknown): value is CopiedRow {
  return value instanceof PluginNode || value instanceof ImplicitMasterNode || value instanceof RecordNode
    || value instanceof WorldspaceNode || value instanceof CellNode || value instanceof PlacedNode;
}

// editor.md, The header: `EditorID [FormKey]`, or the FormKey alone when there is no EditorID.
function copyValueLine(row: CopiedRow): string {
  if (row.kind === 'plugin') return row.plugin.name;
  if (row.kind === 'implicitMaster') return row.name;
  const { formKey, editorId } = row.kind === 'record'
    ? { formKey: row.record.formKey, editorId: row.record.editorId ?? undefined }
    : row;
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

/** Plugins' own text for the catalog's one copy value id (plugins.md, Menus and keys, story 5).
 *  `undefined` unless `clicked` is a Plugins row or the Plugins key's args, so another view's
 *  invocation defers. */
export function pluginsCopyValueText(
  viewSelection: () => readonly PluginsTreeNode[],
): (clicked: unknown, allSelected: readonly unknown[] | undefined) => string | undefined {
  const lines = (entry: GestureEntry) =>
    selectionArgument(entry, ...PLUGIN_ROW_KINDS, ...RECORD_ROW_KINDS).map(copyValueLine).join('\n');
  return (clicked, allSelected) => {
    if (isPluginsKeyArgs(clicked)) return lines({ selection: viewSelection() });
    if (!isCopiedRow(clicked)) return undefined;
    const selected = allSelected?.length ? allSelected.filter(isCopiedRow) : undefined;
    return lines(pluginsGestureEntry(clicked, selected, viewSelection));
  };
}

// The one source (create-plugin, story 1): CreatePluginHandler's server-side refusal reads the
// same Mutagen release fact through Queries, so a game with no light plugins refuses .esl here
// too, before any place pick.
async function promptPluginName(client: Pick<MEditClient, 'getLightPluginsSupported'>): Promise<string | undefined> {
  const lightPluginsSupported = await client.getLightPluginsSupported();
  return vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: v => {
      if (!v) return 'Name is required';
      if (!/\.(esp|esm|esl)$/i.test(v)) return 'Extension must be .esp, .esm, or .esl';
      if (!lightPluginsSupported && /\.esl$/i.test(v)) return 'This game has no light plugins';
      return undefined;
    },
  });
}

// create-plugin: the file is the whole gesture. Its plugins.txt line is plugin sync's, once the
// watch sees the file, so nothing here writes that line or refreshes a view.
export function registerCreatePluginCommand(
  client: Pick<MEditClient, 'createPlugin' | 'getLightPluginsSupported'>,
  mo2: { instance: Pick<Instance, 'value'> } | undefined,
  reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.create', async () => {
    if (!mo2) {
      reporter.report('error', 'Creating a plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName(client);
    if (!name) return;

    const places = pluginPlaces(mo2.instance.value, name);
    if (places.length === 0) {
      reporter.report('error', `Overwrite and every enabled mod already hold "${name}".`);
      return;
    }
    const picked = await vscode.window.showQuickPick(places, { placeHolder: 'Where should the new plugin live?' });
    if (!picked) return;

    const place = placeFolder(mo2.instance.value, picked.origin);
    if ('lost' in place) {
      const became = place.lost === 'gone' ? 'is gone' : 'was disabled';
      reporter.report('error', `The mod "${picked.origin}" ${became}, so "${name}" was not created.`);
      return;
    }

    const result = await client.createPlugin({ name, origin: picked.origin }, place.folder);
    if (isRefused(result)) { reporter.report('error', result.message); return; }
    reporter.landed(`Created "${result.name}" in ${picked.label}.`);
  });
}
