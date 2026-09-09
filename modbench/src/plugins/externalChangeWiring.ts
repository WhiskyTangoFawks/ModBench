import * as vscode from 'vscode';
import * as path from 'path';
import type { MEditClient } from '../medit/client';
import {
  subscribeExternalChangePending, type OpenMergeEditor,
} from '../medit/externalChangeCoordinator';
import type { PluginTreeProvider } from './PluginTreeProvider';

// Its own file, not externalChangeGestures.ts: `subscribeExternalChangePending` (a value import)
// lives in medit/externalChangeCoordinator.ts, which itself imports externalChangeGestures.ts —
// importing back from here would cycle the two modules.

/** ADR-0046 invariant 12: the plugin watcher's signal drives the one dialog directly — no poll,
 *  no health gate, since `notificationSubscriber` already follows the backend's lifecycle.
 *  Returns the unsubscribe. */
export function wireExternalChangePending(
  client: Pick<MEditClient, 'getPlugins' | 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>,
  outputChannel: vscode.LogOutputChannel,
  notificationSubscriber: Pick<MEditClient, 'subscribe'>, treeProvider: PluginTreeProvider, refreshMatchingPlugins: () => void,
): () => void {
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`, built
  // here at the boundary so the flat shape stops at the collaborator that needs it.
  const log = (msg: string) => outputChannel.info(msg);
  return subscribeExternalChangePending({
    controller: client,
    showDialog: (message, options, ...buttons) => Promise.resolve(vscode.window.showWarningMessage(message, options, ...buttons)),
    showRebaseOffer: (message, ...buttons) => Promise.resolve(vscode.window.showInformationMessage(message, ...buttons)),
    openMergeEditor: makeMergeEditorOpener(client, outputChannel),
    showError: (message) => void vscode.window.showErrorMessage(message),
    refreshTree: () => treeProvider.refresh(),
    refreshMatchingPlugins,
    log,
  }, notificationSubscriber);
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
