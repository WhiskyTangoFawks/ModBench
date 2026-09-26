import * as vscode from 'vscode';
import { isRefused, type MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import {
  ImplicitMasterNode, PluginNode, PluginsTreeProvider, type PluginListNode, type PluginsTreeNode, type SortDirection,
} from './PluginsTreeProvider';
import {
  PLUGIN_ROW_KINDS, RECORD_ROW_KINDS, isPluginsKeyArgs, onlySelected, pluginsGestureEntry, selectionArgument, type GestureEntry,
} from './gestureEntry';
import { CellNode, PlacedNode, RecordNode, WorldspaceNode } from './PluginTreeProvider';
import { PLUGIN_DESTINATION_OPTIONS, resolvePluginDestination } from './pluginDestination';
import { appendPlugin } from '../pluginsCommands/plugins';
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

/** Plugins' own text for the catalog's one copy value id (plugins.md, Menus and keys, story 8).
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

async function pickPluginDestination(
  instance: Pick<Instance, 'value'>,
): Promise<{ path: string; origin: string } | undefined> {
  const picked = await vscode.window.showQuickPick(PLUGIN_DESTINATION_OPTIONS, {
    placeHolder: 'Where should the new plugin live?',
  });
  if (!picked) return undefined;
  if (picked.choice === OVERWRITE_ORIGIN) return resolvePluginDestination(instance.value, { kind: OVERWRITE_ORIGIN });

  const modNames = instance.value.mods.filter((e) => e.kind === 'mod').map((e) => e.name);
  const modName = await vscode.window.showQuickPick(modNames, { placeHolder: 'Which mod?' });
  return modName ? resolvePluginDestination(instance.value, { kind: 'existingMod', modName }) : undefined;
}

function promptPluginName(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Enter new plugin name (e.g. MyPatch.esp)',
    validateInput: v => {
      if (!v) return 'Name is required';
      if (!/\.(esp|esm|esl)$/i.test(v)) return 'Extension must be .esp, .esm, or .esl';
      return undefined;
    },
  });
}

// ADR-0007: `appendPlugin` adds the load-order line only once Editing's create has succeeded, so
// the load order never names a missing file. The row arrives with the Instance loader's next value.
async function appendCreatedPluginToLoadOrder(
  instanceRoot: string, instance: Pick<Instance, 'value'>, pluginName: string, reporter: Reporter,
): Promise<void> {
  const result = await appendPlugin(instanceRoot, instance.value.activeProfile, pluginName);
  if (!result.applied) {
    reporter.report(
      'error',
      `Created "${pluginName}", but could not add it to the load order.`,
      result.refusal,
    );
    return;
  }
  reporter.landed(`Created "${pluginName}".`);
}

export function registerCreatePluginCommand(
  client: Pick<MEditClient, 'createPlugin'>,
  mo2: { instance: Pick<Instance, 'value'>; instanceRoot: string } | undefined,
  reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.create', async () => {
    if (!mo2) {
      reporter.report('error', 'Creating a plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName();
    if (!name) return;

    const destination = await pickPluginDestination(mo2.instance);
    if (!destination) return; // user cancelled a prompt

    const result = await client.createPlugin(name, destination.path, destination.origin);
    if (isRefused(result)) { reporter.report('error', result.message); return; }

    await appendCreatedPluginToLoadOrder(mo2.instanceRoot, mo2.instance, result.name, reporter);
  });
}
