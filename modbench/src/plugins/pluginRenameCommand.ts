import * as vscode from 'vscode';
import type { MEditClient, SourceChanges } from '../client';
import type { Instance } from '../instanceLoader/instance';
import type { PluginsCommands, SelectionResult } from '../pluginsCommands/plugins';
import { singularArgument } from '../drivingLib/gestureEntry';
import { registerAgentGesture, type AgentGesture } from '../drivingLib/agentGesture';
import { promptRename } from '../drivingLib/promptRename';
import { applyUnreported } from '../drivingLib/applyAnswered';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';
import { answerOf } from '../wire/readFailed';
import type { PluginAddress } from '../wire/pluginAddress';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { creatablePluginExtensionsOf, pluginNameRefusal } from './pluginName';
import { holdsPlugin } from './pluginPlaces';
import type { PluginsTreeNode } from './pluginRows';

export interface RenamePluginDeps {
  commands: Pick<PluginsCommands, 'confirmRename' | 'renamePlugin'>;
  ask: AskQuestion;
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>;
  source: SourceEditing;
  instance: Pick<Instance, 'value' | 'quiet'>;
  reporter: Reporter;
}

interface Rename {
  readonly plugin: PluginAddress;
  readonly newName: string;
}

type RenameDeps = Pick<RenamePluginDeps, 'commands' | 'source' | 'instance'>;

async function renamed({ commands, source, instance }: RenameDeps, plugin: PluginAddress, newName: string): Promise<SelectionResult<PluginAddress>> {
  const couldNot = `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source`;
  let applyFailure = '';
  const apply = async (changes: SourceChanges) => {
    const failure = await applyUnreported(source, [changes], [plugin]);
    applyFailure = failure ?? '';
    return failure === undefined;
  };
  const result = await commands.renamePlugin({ apply }, plugin, newName, instance.value.gameRelease);
  if (result.applied) return { applied: true, outcome: { landed: [{ name: newName, origin: plugin.origin }], refused: [] } };
  if ('reported' in result) {
    return { applied: false, refusal: `${couldNot} may be partly renamed. Reverting the source rename in git undoes it. ${applyFailure}` };
  }
  if (!result.sourceRenamed) return { applied: false, refusal: result.refusal };
  return {
    applied: false,
    refusal: `${couldNot} was renamed, its file and lines were not. Reverting the source rename in git undoes it. ${result.refusal}`,
  };
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, commands, ask, instance, reporter, source }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const refusalOf = (plugin: PluginAddress, newName: string, creatableExtensions: readonly string[]): string | undefined =>
    pluginNameRefusal(newName, creatableExtensions)
      ?? (holdsPlugin(instance.value, { name: newName, origin: plugin.origin }) ? `"${plugin.origin}" already holds "${newName}".` : undefined);

  const gesture: AgentGesture<PluginsTreeNode, Rename, SelectionResult<PluginAddress>, { name: string }> = {
    fromView: async (entry) => {
      const row = singularArgument(entry, 'plugin');
      if (!row) return undefined;
      const plugin = { name: row.plugin.name, origin: row.origin };
      const creatableExtensions = await creatablePluginExtensionsOf(client, reporter);
      if (creatableExtensions === undefined) return undefined;

      const refusal = (value: string): string | undefined =>
        value === '' || value === plugin.name ? undefined : refusalOf(plugin, value, creatableExtensions);
      const newName = await promptRename('Rename plugin', plugin.name, refusal);
      if (newName === undefined) return undefined;

      const confirmed = await commands.confirmRename(ask, plugin, newName);
      if (!confirmed.confirmed) {
        if (confirmed.refusal !== undefined) reporter.report('error', confirmed.refusal);
        return undefined;
      }
      return { plugin, newName };
    },
    fromAgent: async ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Error('An agent call to rename a plugin carries one plugin.');
      const plugin = pluginOf(only);
      const refusal = refusalOf(plugin, name, answerOf(await client.getCreatablePluginExtensions()));
      if (refusal !== undefined) throw new Error(refusal);
      return { plugin, newName: name };
    },
    run: async ({ plugin, newName }) => vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(() => source.oneAtATime(() => renamed({ commands, source, instance }, plugin, newName)))),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal);
    },
  };
  return registerAgentGesture('modbench.plugin.rename', viewSelection, gesture);
}
