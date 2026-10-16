import * as vscode from 'vscode';
import type { MEditClient, SourceChanges } from '../client';
import type { Instance } from '../instanceLoader/instance';
import type { PluginsCommands } from '../pluginsCommands/plugins';
import { singularArgument } from '../drivingLib/gestureEntry';
import { registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { promptRename } from '../drivingLib/promptRename';
import { applyUnreported } from '../drivingLib/applyAnswered';
import type { SourceEditing } from '../drivingLib/sourceEditing';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import { Refusal } from '../drivingLib/refusal';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { creatablePluginExtensionsOf } from './creatablePluginExtensions';
import type { PluginsTreeNode } from './pluginRows';

export interface RenamePluginDeps {
  commands: Pick<PluginsCommands, 'confirmRename' | 'renameRefusal' | 'renamePlugin'>;
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

const refused = (refusal: string, detail?: string): GestureResult<PluginAddress> => ({ applied: false, refusal, detail });

async function renamed({ commands, source, instance }: RenameDeps, plugin: PluginAddress, newName: string): Promise<GestureResult<PluginAddress>> {
  const couldNot = `Could not rename "${plugin.name}" (${plugin.origin}): its plugin source`;
  const apply = (changes: SourceChanges) => applyUnreported(source, [changes], [plugin]);
  const result = await commands.renamePlugin({ apply }, plugin, newName, instance.value.gameRelease);
  if (result.applied) return { applied: true, outcome: { landed: [{ name: newName, origin: plugin.origin }], refused: [] } };
  if ('reported' in result) return refused(`${couldNot} may be partly renamed. Reverting the source rename in git undoes it.`, result.reported);
  if (!result.sourceRenamed) return refused(result.refusal, result.detail);
  return refused(`${couldNot} was renamed, its file and lines were not. Reverting the source rename in git undoes it.`, result.refusal);
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, commands, ask, instance, reporter, source }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, Rename, GestureResult<PluginAddress>, { name: string }> = {
    fromView: async (entry) => {
      const row = singularArgument(entry, 'plugin');
      if (!row) return undefined;
      const plugin = { name: row.plugin.name, origin: row.origin };
      const creatableExtensions = await creatablePluginExtensionsOf(client, reporter);
      if (creatableExtensions === undefined) return undefined;

      const refusal = async (value: string): Promise<string | undefined> => {
        if (value === '' || value === plugin.name) return undefined;
        try {
          return await commands.renameRefusal(plugin, value, creatableExtensions);
        } catch (err) {
          return `Could not check "${value}": ${errorMessage(err)}`;
        }
      };
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
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to rename a plugin carries one plugin.');
      const plugin = pluginOf(only);
      return { plugin, newName: name };
    },
    run: async ({ plugin, newName }) => vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(() => source.oneAtATime(() => renamed({ commands, source, instance }, plugin, newName)))),
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  return registerAgentGesture('modbench.plugin.rename', viewSelection, gesture);
}
