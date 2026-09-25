import * as vscode from 'vscode';
import * as path from 'node:path';
import type { CrashRepairOffer, MEditClient } from '../client';
import {
  subscribeQuestionOpen, type OpenMergeEditor,
} from './externalChangeCoordinator';
import type { PluginTreeProvider } from './PluginTreeProvider';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import { errorMessage } from '../ports/errorMessage';

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
  reporter: Reporter,
): () => void {
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`, built
  // here at the boundary so the flat shape stops at the collaborator that needs it.
  const log = (msg: string) => outputChannel.info(msg);
  return subscribeQuestionOpen({
    client,
    showDialog: askQuestion,
    openMergeEditor: makeMergeEditorOpener(client, outputChannel, reporter),
    reporter,
    refreshTree: () => treeProvider.refresh(),
    refreshMatchingPlugins,
    presentCrashRepair,
    log,
  }, client);
}

/** Resolved fresh per call: several repositories can be mid-answer at once. `git.mergeEditor`
 *  defaults off, so only `git.openMergeEditor` opens the real merge editor; `vscode.open` is
 *  its fallback, reported, when that command is unavailable or throws. */
export function makeMergeEditorOpener(
  client: Pick<MEditClient, 'getPlugins'>, outputChannel: vscode.LogOutputChannel, reporter: Reporter,
): OpenMergeEditor {
  return async (origin, relativePath) => {
    const plugins = await client.getPlugins();
    const anyPluginPath = plugins.find((p) => p.origin === origin)?.path;
    const modFolder = anyPluginPath ? path.dirname(anyPluginPath) : undefined;
    if (!modFolder) {
      outputChannel.error(`[extension] openMergeEditor: could not resolve "${origin}"'s mod folder`);
      return;
    }
    const uri = vscode.Uri.file(path.join(modFolder, relativePath));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch (err) {
      const detail = errorMessage(err);
      outputChannel.error(`[extension] git.openMergeEditor failed for "${relativePath}": ${detail}`);
      await vscode.commands.executeCommand('vscode.open', uri);
      reporter.report(
        'warning',
        `Could not open the merge editor for "${relativePath}" — opened it as a text editor instead.`,
        detail,
      );
    }
  };
}
