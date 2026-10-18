import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import type { EditingDeps } from '../instanceCommands/editing';
import { RecordBrowser } from './RecordBrowser';
import { createStatusBar } from './statusBar';
import { noticeExternalChanges } from './externalChangeNotice';
import { recordWriteOver } from './recordWrite';
import { editingView } from './editingView';
import { createPluginsView, type PluginsView, type PluginsViewDeps } from './pluginsView';
import type { PluginConditions } from '../drivingLib/recordRowContext';
import type { PluginAddress } from '../client';
import type { ReconcileNarrator } from './reconcileNarrator';
export { PLUGINS_KEY_ARGS } from './gestureEntry';

type PluginsClient = PluginsViewDeps['client'] & ConstructorParameters<typeof RecordBrowser>[0]
  & Parameters<typeof createStatusBar>[0] & Parameters<typeof noticeExternalChanges>[1] & EditingDeps['client'];

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

type PluginsInstanceDeps = Pick<PluginsViewDeps,
  'instance' | 'commands' | 'pluginSync' | 'dataFolderFile'
>;

interface PluginsOnInstance extends vscode.Disposable {
  followed: PluginsView['followed'];
  nameFilter: PluginsView['nameFilter'];
  copyValue: PluginsView['copyValue'];
  /** The Plugins view's message line, where another view's gesture says its phase. */
  say: PluginsView['progress']['say'];
  editingInPluginsView: Pick<EditingDeps, 'around' | 'onPut'>;
  nextRefill: ReconcileNarrator['nextRefill'];
}

export interface Plugins extends vscode.Disposable {
  /** What a record gesture runs under: the record index must show the write before it lands. */
  recordWrite: RecordWrite;
  /** What the Plugins view knows of whether a plugin is a compiled plugin, and its editability; nothing is editable while no Instance is open. */
  conditionsOf(plugin: PluginAddress): PluginConditions;
  /** The Plugins view, over an Instance that was found. */
  onInstance(deps: PluginsInstanceDeps): PluginsOnInstance;
}

export function createPlugins(deps: PluginsDeps): Plugins {
  const { client, channel, reporterFor } = deps;
  const statusBar = createStatusBar(client);
  const externalChanges = noticeExternalChanges(reporterFor('externalChange'), client);
  const recordBrowser = new RecordBrowser(client, channel);
  const recordWrite = recordWriteOver(deps.facts, client);
  let shown: PluginsView | undefined;
  return {
    recordWrite,
    conditionsOf: (plugin) => shown?.conditionsOf(plugin) ?? { editable: false },
    onInstance: (instanceDeps) => {
      const view = createPluginsView({
        ...instanceDeps, recordBrowser, client, statusBar, channel, registerRepositories: deps.registerRepositories, reporterFor,
        ask: deps.ask, recordWrite, sourceEditing: deps.sourceEditing,
        log: (level, msg) => channel[level](msg),
      });
      shown = view;
      const editingInPluginsView = editingView({
        narrator: view.narrator, progress: view.progress, log: channel, revealLog: () => channel.show(true), loadOrderPut: view.loadOrderPut,
        reporterFor,
      });
      return {
        followed: view.followed, nameFilter: view.nameFilter, copyValue: view.copyValue, say: view.progress.say, editingInPluginsView,
        nextRefill: () => view.narrator.nextRefill(),
        dispose: () => {
          if (shown === view) shown = undefined;
          view.dispose();
        },
      };
    },
    dispose: () => { externalChanges(); statusBar.dispose(); },
  };
}
