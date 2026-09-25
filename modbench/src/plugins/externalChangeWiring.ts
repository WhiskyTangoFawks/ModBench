import type * as vscode from 'vscode';
import type { CrashRepairOffer, MEditClient } from '../client';
import { subscribeQuestionOpen } from './externalChangeCoordinator';
import type { PluginTreeProvider } from './PluginTreeProvider';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';

// Its own file, not externalChangeGestures.ts: `subscribeQuestionOpen` (a value import)
// lives in ./externalChangeCoordinator.ts, which itself imports externalChangeGestures.ts —
// importing back from here would cycle the two modules.

/** ADR-0014 invariant 2: the plugin watcher's signal drives the one dialog directly — no poll,
 *  no health gate, since `client.subscribe` already follows the backend's lifecycle. Returns the
 *  unsubscribe. */
export interface QuestionOpenWiring {
  client: Pick<MEditClient, 'getPlugins' | 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'subscribe'>;
  outputChannel: vscode.LogOutputChannel;
  treeProvider: PluginTreeProvider;
  refreshMatchingPlugins: () => void;
  askQuestion: AskQuestion;
  presentCrashRepair: (offers: CrashRepairOffer[]) => Promise<void>;
  reporter: Reporter;
}

export function wireQuestionOpen({
  client, outputChannel, treeProvider, refreshMatchingPlugins, askQuestion, presentCrashRepair, reporter,
}: QuestionOpenWiring): () => void {
  // `log` is a compat shim (defaults to .info) for modules taking a flat `(msg) => void`, built
  // here at the boundary so the flat shape stops at the collaborator that needs it.
  const log = (msg: string) => outputChannel.info(msg);
  return subscribeQuestionOpen({
    client,
    showDialog: askQuestion,
    reporter,
    refreshTree: () => treeProvider.refresh(),
    refreshMatchingPlugins,
    presentCrashRepair,
    log,
  }, client);
}
