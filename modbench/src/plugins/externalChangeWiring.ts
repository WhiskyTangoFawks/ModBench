import * as vscode from 'vscode';
import * as path from 'path';
import type { CrashRepairOffer, MEditClient } from '../medit/client';
import {
  subscribeQuestionOpen, type OpenMergeEditor,
} from './externalChangeCoordinator';
import type { PluginTreeProvider } from './PluginTreeProvider';
import { makeReporter } from '../reporter';
import type { AskQuestion } from '../dialog';

// Its own file, not externalChangeGestures.ts: `subscribeQuestionOpen` (a value import)
// lives in ./externalChangeCoordinator.ts, which itself imports externalChangeGestures.ts —
// importing back from here would cycle the two modules.

/** ADR-0014 invariant 2: the plugin watcher's signal drives the one dialog directly — no poll,
 *  no health gate, since `client.subscribe` already follows the backend's lifecycle. Returns the
 *  unsubscribe. */
export function wireQuestionOpen(
  client: Pick<MEditClient, 'getPlugins' | 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain' | 'subscribe'>,
  outputChannel: vscode.LogOutputChannel,
  treeProvider: PluginTreeProvider, refreshMatchingPlugins: () => void,
  askQuestion: AskQuestion,
  presentCrashRepair: (offers: CrashRepairOffer[]) => Promise<void>,
): () => void {
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`, built
  // here at the boundary so the flat shape stops at the collaborator that needs it.
  const log = (msg: string) => outputChannel.info(msg);
  const reporter = makeReporter(outputChannel, 'externalChange');
  return subscribeQuestionOpen({
    client,
    showDialog: askQuestion,
    openMergeEditor: makeMergeEditorOpener(client, outputChannel),
    showError: (message) => reporter.report('error', message),
    refreshTree: () => treeProvider.refresh(),
    refreshMatchingPlugins,
    presentCrashRepair,
    log,
  }, client);
}

/** Resolved fresh per call rather than bound to one origin: the dialog-driven path has no single
 *  resolved origin in scope, since several repositories can be mid-answer at once. `vscode.open`
 *  is git's own merge-editor gesture, scripted. */
export function makeMergeEditorOpener(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: vscode.LogOutputChannel,
): OpenMergeEditor {
  return async (origin, relativePath) => {
    const plugins = await client.getPlugins();
    const anyPluginPath = plugins.find((p) => p.origin === origin)?.path;
    const modFolder = anyPluginPath ? path.dirname(anyPluginPath) : undefined;
    if (!modFolder) {
      outputChannel.error(`[extension] openMergeEditor: could not resolve "${origin}"'s mod folder`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(modFolder, relativePath)));
  };
}
