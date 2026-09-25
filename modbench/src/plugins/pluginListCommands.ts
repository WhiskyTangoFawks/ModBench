import * as vscode from 'vscode';
import { isRefused, type MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import { PluginsTreeProvider, type PluginListNode } from './PluginsTreeProvider';
import { PLUGIN_DESTINATION_OPTIONS, resolvePluginDestination } from './pluginDestination';
import { appendPlugin } from '../pluginsCommands/plugins';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';

// The row's own reveal-in-Explorer gesture — an MO2-instance-scoped fact (which plugin copy
// wins, where its file lives), so it reads through the tree rather than a disk lookup of its own.
export function registerRevealInExplorerCommand(
  pluginsTree: Pick<PluginsTreeProvider, 'resolvePluginPath'>, reporter: Reporter,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.plugin.reveal', async (node: PluginListNode | undefined) => {
    if (node?.kind !== 'plugin') return;
    const name = node.plugin.name;
    const filePath = await pluginsTree.resolvePluginPath(name);
    if (!filePath) {
      // ADR-0019: an explicit user action failed — notify + log, never a silent no-op.
      reporter.report('error', `Could not resolve a file location for "${name}" — it is not in the load order.`);
      return;
    }
    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
    } catch (err) {
      reporter.report('error', `Failed to reveal "${name}" in Explorer.`, errorMessage(err));
    }
  });
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

// ADR-0007: only once Editing's create endpoint has actually succeeded does Mod Management's
// `appendPlugin` add the load-order line — never the other way around, so the load order can
// never name a file that does not exist.
async function appendCreatedPluginToLoadOrder(
  instanceRoot: string, instance: Pick<Instance, 'value'>, pluginsTree: Pick<PluginsTreeProvider, 'invalidate'>,
  pluginName: string, reporter: Reporter,
): Promise<void> {
  const result = await appendPlugin(instanceRoot, instance.value.activeProfile, pluginName);
  pluginsTree.invalidate();
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
  mo2: { instance: Pick<Instance, 'value'>; instanceRoot: string; pluginsTree: Pick<PluginsTreeProvider, 'invalidate'> } | undefined,
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

    await appendCreatedPluginToLoadOrder(mo2.instanceRoot, mo2.instance, mo2.pluginsTree, result.name, reporter);
  });
}
