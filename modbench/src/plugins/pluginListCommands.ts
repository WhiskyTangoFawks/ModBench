import * as vscode from 'vscode';
import type { EditingController } from '../medit/EditingController';
import type { Instance } from '../modmanager/instance';
import { PluginsTreeProvider, type PluginListNode } from './PluginsTreeProvider';
import { PLUGIN_DESTINATION_OPTIONS, resolvePluginDestination } from '../modmanager/pluginDestination';
import { appendPlugin } from '../modmanager/commands/plugins';
import { makeReporter } from '../reporter';

// The row's own reveal-in-Explorer gesture — an MO2-instance-scoped fact (which plugin copy
// wins, where its file lives), so it reads through the tree rather than a disk lookup of its own.
export function registerRevealInExplorerCommand(
  pluginsTree: PluginsTreeProvider, outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  const revealReporter = makeReporter(outputChannel, 'pluginListTree.revealInExplorer');
  return vscode.commands.registerCommand('modbench.pluginListTree.revealInExplorer', async (node: PluginListNode | undefined) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const filePath = await pluginsTree.resolvePluginPath(name);
    if (!filePath) {
      // ADR-0026: an explicit user action failed — notify + log, never a silent no-op.
      revealReporter.report('error', `Could not resolve a file location for "${name}".`);
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
      revealReporter.report('error', `Failed to reveal "${name}" in Explorer.`, err instanceof Error ? err.message : String(err));
    }
  });
}

async function pickPluginDestination(
  instance: Instance, instanceRoot: string,
): Promise<{ path: string; origin: string } | undefined> {
  const picked = await vscode.window.showQuickPick(PLUGIN_DESTINATION_OPTIONS, {
    placeHolder: 'Where should the new plugin live?',
  });
  if (!picked) return undefined;
  if (picked.choice === 'overwrite') return resolvePluginDestination(instanceRoot, { kind: 'overwrite' });

  const modNames = instance.value.mods.filter((e) => e.kind === 'mod').map((e) => e.name);
  const modName = await vscode.window.showQuickPick(modNames, { placeHolder: 'Which mod?' });
  return modName ? resolvePluginDestination(instanceRoot, { kind: 'existingMod', modName }) : undefined;
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

// ADR-0041: only once Editing's create endpoint has actually succeeded does Mod Management's
// `appendPlugin` add the load-order line — never the other way around, so the load order can
// never name a file that does not exist.
async function appendCreatedPluginToLoadOrder(
  instanceRoot: string, instance: Instance, pluginsTree: PluginsTreeProvider,
  pluginName: string, outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const result = await appendPlugin(instanceRoot, instance.value.activeProfile, pluginName);
  pluginsTree.invalidate();
  if (!result.applied) {
    makeReporter(outputChannel, 'newPlugin').report(
      'error',
      `Created "${pluginName}", but could not add it to the load order — add it manually in the Plugins tree.`,
      result.refusal,
    );
    return;
  }
  void vscode.window.showInformationMessage(`Modbench: Created "${pluginName}".`);
}

export function registerCreatePluginCommand(
  controller: EditingController,
  mo2: { instance: Instance; instanceRoot: string; pluginsTree: PluginsTreeProvider } | undefined,
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable {
  const reporter = makeReporter(outputChannel, 'newPlugin');
  return vscode.commands.registerCommand('modbench.newPlugin', async () => {
    if (!mo2) {
      reporter.report('error', 'New Plugin needs an open MO2 instance workspace.');
      return;
    }

    const name = await promptPluginName();
    if (!name) return;

    const destination = await pickPluginDestination(mo2.instance, mo2.instanceRoot);
    if (!destination) return; // user cancelled a prompt

    // EditingController.createPlugin already surfaces its own failure (ADR-0026) — nothing more
    // to do here than stop.
    const created = await controller.createPlugin(name, destination.path, destination.origin);
    if (!created) return;

    await appendCreatedPluginToLoadOrder(mo2.instanceRoot, mo2.instance, mo2.pluginsTree, created.name, outputChannel);
  });
}
