import * as vscode from 'vscode';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { RecordWrite } from '../drivingLib/writingGesture';
import type { Instance } from '../instanceLoader/instance';
import { editingFlow, type EditingDeps, type EditingFlow } from '../instanceCommands/editing';
import { RecordBrowser } from './RecordBrowser';
import { createStatusBar } from './statusBar';
import { noticeExternalChanges } from './externalChangeNotice';
import { recordWriteOver } from './recordWrite';
import { editingView } from './editingView';
import { createPluginsView, type PluginsView, type PluginsViewDeps } from './pluginsView';
import type { ReconcileNarrator } from './reconcileNarrator';

type PluginsClient = PluginsViewDeps['client'] & ConstructorParameters<typeof RecordBrowser>[0]
  & Parameters<typeof createStatusBar>[0] & Parameters<typeof noticeExternalChanges>[1] & EditingDeps['client'];

export interface PluginsDeps {
  client: PluginsClient;
  facts: Pick<Instance, 'refresh'>;
  channel: vscode.LogOutputChannel;
  reporterFor: (tag: string) => Reporter;
  /** Registers the tracked mods' repositories: a reconcile reached Ready, or a track landed. */
  registerRepositories: () => Promise<void>;
  ask: AskQuestion;
  sourceEditing: PluginsViewDeps['sourceEditing'];
}

type PluginsInstanceDeps = Pick<PluginsViewDeps,
  'instance' | 'commands' | 'pluginSync' | 'saveUnsavedPluginSource' | 'trackSelection' | 'modsView' | 'dataFolderFile'
> & { instanceRoot: string };

interface PluginsOnInstance extends vscode.Disposable {
  followed: PluginsView['followed'];
  nameFilter: PluginsView['nameFilter'];
  copyValue: PluginsView['copyValue'];
  /** The launch and the load order's puts, which the Plugins view says. */
  editing: EditingFlow;
  nextRefill: ReconcileNarrator['nextRefill'];
}

export interface Plugins extends vscode.Disposable {
  /** What a record gesture runs under: the index must show the write before it lands. */
  recordWrite: RecordWrite;
  /** The Plugins view, over an Instance that was found. */
  onInstance(deps: PluginsInstanceDeps): PluginsOnInstance;
}

export function createPlugins(deps: PluginsDeps): Plugins {
  const { client, channel, reporterFor } = deps;
  const statusBar = createStatusBar(client);
  const externalChanges = noticeExternalChanges(reporterFor('externalChange'), client);
  const recordBrowser = new RecordBrowser(client, (line) => channel.info(line));
  const recordWrite = recordWriteOver(deps.facts, client);
  return {
    recordWrite,
    onInstance: ({ instanceRoot, ...instanceDeps }) => {
      const view = createPluginsView({
        ...instanceDeps, recordBrowser, client, statusBar, channel, registerRepositories: deps.registerRepositories, reporterFor,
        ask: deps.ask, recordWrite, sourceEditing: deps.sourceEditing,
        log: (level, msg) => channel[level](msg),
      });
      const shown = editingView({
        narrator: view.narrator, progress: view.progress, log: channel, revealLog: () => channel.show(true), loadOrderPut: view.loadOrderPut,
        reporterFor,
      });
      const editing = editingFlow({
        client, instanceRoot, around: shown.around, tell: shown.tell, log: (line) => channel.error(line),
      });
      return {
        followed: view.followed, nameFilter: view.nameFilter, copyValue: view.copyValue, editing,
        nextRefill: () => view.narrator.nextRefill(),
        dispose: () => { vscode.Disposable.from(editing, view).dispose(); },
      };
    },
    dispose: () => { externalChanges(); statusBar.dispose(); },
  };
}
