import * as vscode from 'vscode';
import type { MEditClient } from '../client';
import type { Instance } from '../instanceLoader/instance';
import type { PluginCommands } from '../pluginCommands/plugins';
import { singularArgument } from '../drivingLib/gestureEntry';
import { registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure } from '../drivingLib/agentGesture';
import { promptRename } from '../drivingLib/promptRename';
import { heldTexts, type FileChanges } from '../symbolNames/symbolNames';
import { applyAnswered } from '../textDocuments/applyAnswered';
import { unsavedTexts } from '../textDocuments/heldText';
import type { SourceEditing } from '../textDocuments/sourceEditing';
import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { PluginAddress } from '../wire/pluginAddress';
import { Refusal } from '../drivingLib/refusal';
import { holdingTheWrite } from '../drivingLib/writingGesture';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import { creatablePluginExtensionsOf } from './creatablePluginExtensions';
import type { PluginsTreeNode } from './pluginRows';

export interface RenamePluginDeps {
  commands: Pick<PluginCommands, 'renameRefusal' | 'renamePlugin'>;
  client: Pick<MEditClient, 'getCreatablePluginExtensions'>;
  source: SourceEditing;
  instance: Pick<Instance, 'value' | 'quiet'>;
  reporter: Reporter;
}

interface Rename {
  readonly plugin: PluginAddress;
  readonly newName: string;
}

type RenameDeps = Pick<RenamePluginDeps, 'commands' | 'source'>;

const isAddress = (value: unknown): value is PluginAddress =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string' && typeof Reflect.get(value, 'origin') === 'string';

// Rename Symbol supplies the plugin and the new name (source.md, In the text editor).
const isSupplied = (option: unknown): option is { readonly plugin: PluginAddress; readonly name: string } =>
  typeof option === 'object' && option !== null && typeof Reflect.get(option, 'name') === 'string' && isAddress(Reflect.get(option, 'plugin'));

const refused = (refusal: string, detail?: string): GestureResult<PluginAddress> => ({ applied: false, refusal, detail });

// symbols.md, The features, story 7: what could not follow lands as a warning naming each reference.
const leftBehind = (plugin: PluginAddress, newName: string, cannotFollow: readonly string[]): { partial?: PartialFailure[] } =>
  (cannotFollow.length === 0 ? {} : {
    partial: [{
      message: `Renamed "${plugin.name}" (${plugin.origin}) to "${newName}". ${String(cannotFollow.length)} references to it could not follow.`,
      detail: cannotFollow.join('\n'),
      severity: 'warning',
    }],
  });

async function renamed({ commands, source }: RenameDeps, plugin: PluginAddress, newName: string): Promise<GestureResult<PluginAddress>> {
  const couldNot = `Could not rename "${plugin.name}" (${plugin.origin})`;
  const apply = (changes: readonly FileChanges[]) => applyAnswered(source, changes, [plugin]);
  const result = await commands.renamePlugin({ held: heldTexts(unsavedTexts()), apply }, plugin, newName);
  if (result.applied) {
    return { applied: true, outcome: { landed: [{ name: newName, origin: plugin.origin }], refused: [] }, ...leftBehind(plugin, newName, result.cannotFollow) };
  }
  if ('unapplied' in result) return refused(`${couldNot}: its references may be partly changed. Reverting them in git undoes it.`, result.unapplied);
  if ('refusal' in result) return refused(result.refusal, 'detail' in result ? result.detail : undefined);
  if (!result.edited) return refused(`${couldNot}: its file and lines were not renamed.`, result.failed);
  return refused(`${couldNot}: its references were changed, its file and lines were not. Reverting them in git undoes it.`, result.failed);
}

/** commands.md, `rename` under Plugin. */
export function registerRenamePluginCommand(
  { client, commands, instance, reporter, source }: RenamePluginDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, Rename, GestureResult<PluginAddress>, { name: string }> = {
    fromView: async (entry, option) => {
      if (isSupplied(option)) return { plugin: option.plugin, newName: option.name };
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

      return { plugin, newName };
    },
    fromAgent: ({ argument, options: { name } }) => {
      const [only, ...more] = argument;
      if (only === undefined || more.length > 0) throw new Refusal('An agent call to rename a plugin carries one plugin.');
      const plugin = pluginOf(only);
      return { plugin, newName: name };
    },
    run: ({ plugin, newName }) => holdingTheWrite('modbench.plugin.rename', async () => vscode.window.withProgress({ location: { viewId: PLUGINS_KEY_ARGS.view } }, () =>
      instance.quiet(() => source.oneAtATime(() => renamed({ commands, source }, plugin, newName))))),
    report: (result) => {
      if (result.applied) reportPartial(reporter, result.partial);
      else reporter.report('error', result.refusal, result.detail);
    },
  };
  return registerAgentGesture('modbench.plugin.rename', viewSelection, gesture);
}
