import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { Instance } from '../instanceLoader/instance';
import type { EditingDeps } from '../instanceCommands/editing';
import { RecordBrowser } from './RecordBrowser';
import { createStatusBar } from './statusBar';
import { recordWriteOver } from '../drivingLib/recordWrite';
import { PLUGINS_KEY_ARGS } from './gestureEntry';
import { editingView } from './editingView';
import { createPluginsView, type PluginsView, type PluginsViewDeps } from './pluginsView';
import type { ReconcileNarrator } from './reconcileNarrator';
import type { PluginSyncRun } from '../pluginCommands/plugins';
import { pluginSyncOn, registerPluginSyncCommand } from './pluginSync';
export { PLUGINS_KEY_ARGS };

type PluginsClient = PluginsViewDeps['client'] & ConstructorParameters<typeof RecordBrowser>[0]
  & Parameters<typeof createStatusBar>[0] & EditingDeps['client'];

export interface PluginsDeps {
  client: PluginsClient;
  facts: Pick<Instance, 'refresh'>;
  channel: Pick<vscode.LogOutputChannel, 'error' | 'info' | 'warn' | 'show'>;
  reporterFor: (tag: string) => Reporter;
  /** Registers the source mods' repositories: a reconcile reached Ready. */
  registerRepositories: () => Promise<void>;
  ask: AskQuestion;
  sourceEditing: PluginsViewDeps['sourceEditing'];
}

type PluginsInstanceDeps = Pick<PluginsViewDeps, 'instance' | 'commands' | 'writeRules' | 'modStatuses'> & {
  syncPlugins: PluginSyncRun;
};

interface PluginsOnInstance extends vscode.Disposable {
  followed: PluginsView['followed'];
  nameFilter: PluginsView['nameFilter'];
  copyValue: PluginsView['copyValue'];
  relatesRows: PluginsView['relatesRows'];
  drawsHighlight: PluginsView['drawsHighlight'];
  /** The Plugins view's message line, where another view's gesture says its phase. */
  say: PluginsView['progress']['say'];
  editingInPluginsView: Pick<EditingDeps, 'around' | 'onPut'>;
  nextRefill: ReconcileNarrator['nextRefill'];
  pluginsShown: PluginsView['pluginsShown'];
}

export interface Plugins extends vscode.Disposable {
  /** The lines the agent reads with mEdit's answers and with the plugins. */
  readonly standing: { mEdit: () => string[]; plugins: () => string[]; sortingRules: () => string[] };
  /** The Plugins view, over an Instance that was found. */
  onInstance(deps: PluginsInstanceDeps): PluginsOnInstance;
}

export function createPlugins(deps: PluginsDeps): Plugins {
  const { client, channel, reporterFor } = deps;
  const statusBar = createStatusBar(client, reporterFor);
  const recordBrowser = new RecordBrowser(client);
  const recordWrite = recordWriteOver(PLUGINS_KEY_ARGS.view, deps.facts, client);
  let pluginLines: () => string[] = () => [];
  let ruleLines: () => string[] = () => [];
  return {
    standing: { mEdit: () => [statusBar.standing()].filter((line) => line !== undefined), plugins: () => pluginLines(), sortingRules: () => ruleLines() },
    onInstance: ({ syncPlugins, ...instanceDeps }) => {
      const syncing = pluginSyncOn({ instance: instanceDeps.instance, syncPlugins, channel });
      const syncCommand = registerPluginSyncCommand(syncing.pluginSync);
      const view = createPluginsView({
        ...instanceDeps, pluginSync: syncing.pluginSync, recordBrowser, client, statusBar, channel, registerRepositories: deps.registerRepositories, reporterFor,
        ask: deps.ask, recordWrite, sourceEditing: deps.sourceEditing,
        log: (level, msg) => channel[level](msg),
      });
      pluginLines = view.standingLines;
      ruleLines = view.sortingRuleLines;
      const editingInPluginsView = editingView({
        narrator: view.narrator, progress: view.progress, log: channel, revealLog: () => channel.show(true), loadOrderPut: view.loadOrderPut,
        reporterFor,
      });
      return {
        followed: view.followed, nameFilter: view.nameFilter, copyValue: view.copyValue, relatesRows: view.relatesRows, drawsHighlight: view.drawsHighlight, say: view.progress.say, editingInPluginsView, pluginsShown: view.pluginsShown,
        nextRefill: () => view.narrator.nextRefill(),
        dispose: () => {
          syncCommand.dispose();
          syncing.dispose();
          view.dispose();
        },
      };
    },
    dispose: () => { statusBar.dispose(); },
  };
}
