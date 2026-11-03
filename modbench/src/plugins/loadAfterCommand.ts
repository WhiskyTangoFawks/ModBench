import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { LoadAfter } from '../sortingRules/lootMetadata';
import { registerAgentGesture, type AgentGesture, type GestureResult } from '../drivingLib/agentGesture';
import { pluralArgument } from '../drivingLib/gestureEntry';
import { Refusal } from '../drivingLib/refusal';
import { runWritingGesture } from '../drivingLib/writingGesture';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import { pluginNameKey, type PluginAddress } from '../wire/pluginAddress';
import { PLUGINS_KEY_ARGS, pluginOf } from './gestureEntry';
import type { PluginsTreeNode } from './pluginRows';

export interface LoadAfterDeps {
  changeUserlist: (additions: readonly LoadAfter[]) => Promise<unknown>;
  instance: Pick<Instance, 'refresh'>;
  reporter: Reporter;
  places: (selected: readonly string[]) => readonly string[];
}

interface Choice {
  readonly plugins: readonly PluginAddress[];
  readonly after: readonly string[];
}

/** `modbench.plugin.loadAfter` (commands.md): each selected plugin loads after each plugin picked. */
export function registerLoadAfterCommand(
  { changeUserlist, instance, reporter, places }: LoadAfterDeps, viewSelection: () => readonly PluginsTreeNode[],
): vscode.Disposable {
  const gesture: AgentGesture<PluginsTreeNode, Choice, GestureResult<PluginAddress>, { after: { name: string }[] }> = {
    fromView: async (entry) => {
      const plugins = pluralArgument(entry, 'plugin').map(({ plugin, origin }) => ({ name: plugin.name, origin }));
      if (plugins.length === 0) return undefined;
      const picked = await vscode.window.showQuickPick(
        places(plugins.map(({ name }) => name)).map((label) => ({ label })), { placeHolder: 'Load after…', canPickMany: true },
      );
      return picked === undefined || picked.length === 0 ? undefined : { plugins, after: picked.map(({ label }) => label) };
    },
    fromAgent: ({ argument, options }) => {
      const plugins = argument.map(pluginOf);
      const after = options.after.map(({ name }) => name);
      if (plugins.length === 0 || after.length === 0) throw new Refusal('An agent call to load after carries the plugins and the plugins they load after.');
      const itself = plugins.find(({ name }) => after.some((other) => pluginNameKey(other) === pluginNameKey(name)));
      if (itself) throw new Refusal(`"${itself.name}" cannot load after itself.`);
      return { plugins, after };
    },
    run: async ({ plugins, after }) => {
      try {
        await runWritingGesture(PLUGINS_KEY_ARGS.view, instance, () => changeUserlist(plugins.map(({ name }) => ({ plugin: name, after }))));
        return { applied: true, outcome: { landed: plugins, refused: [] } };
      } catch (e) {
        return { applied: false, refusal: 'Could not write the load after.', detail: errorMessage(e) };
      }
    },
    report: (result) => {
      if (!result.applied) reporter.report('error', result.refusal, result.detail);
    },
  };
  return registerAgentGesture('modbench.plugin.loadAfter', viewSelection, gesture);
}
