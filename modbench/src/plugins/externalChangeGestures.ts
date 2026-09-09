import * as vscode from 'vscode';
import * as path from 'path';
import type { ExternalChangeDialogAnswer } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { UnansweredExternalChange, RebaseResult } from '../medit/ApiClient';
import { isRefused, type MEditClient } from '../medit/client';
import {
  subscribeExternalChangePending, type ExternalChangeCoordinatorDeps, type OpenMergeEditor,
} from '../medit/externalChangeCoordinator';
import type { NotificationSubscriber } from '../medit/NotificationSubscriber';
import type { PluginTreeProvider } from './PluginTreeProvider';

/** The rebase offer is a separate, non-modal notification by contract, never folded into the
 *  external-change dialog itself. */
export const REBASE_NOW_BUTTON = 'Rebase Now';
export const REBASE_LATER_BUTTON = 'Later';

// Fixed by CONTEXT.md's "Edit branch", never derived per repository.
const EDIT_BRANCH_NAME = 'edit';

export function rebaseOfferMessage(origin: string): string {
  return `main moved ahead of "${EDIT_BRANCH_NAME}" in ${origin}.`;
}

/** Non-modal by construction: no `{ modal: true }` option is offered. */
export type ShowRebaseOffer = (message: string, ...buttons: string[]) => Thenable<string | undefined> | Promise<string | undefined>;

// The coordinator decides *when* to call this; this decides what each dialog answer does —
// Absorb Upstream Update or Keep as My Edit.
export async function handleUnanswered(deps: ExternalChangeCoordinatorDeps, unanswered: UnansweredExternalChange[]): Promise<void> {
  const outcomes = await runExternalChangeDialogs(unanswered, deps.showDialog);
  for (const { change: item, answer } of outcomes) {
    // Sequential, deliberately: two dispatches for one repository (two plugins in the same folder
    // can both be queued) must not overlap a rebase offer against an absorb still in flight.
    await dispatchOne(deps, item, answer);
  }
}

function refreshAfterWrite(deps: Pick<ExternalChangeCoordinatorDeps, 'refreshTree' | 'refreshMatchingPlugins'>): void {
  deps.refreshTree();
  deps.refreshMatchingPlugins();
}

async function dispatchKeep(deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange): Promise<void> {
  const result = await deps.controller.keepAsMyEdit(item.plugin, item.origin);
  if (result && isRefused(result)) { deps.showError(result.message); return; }
  // A refused Keep (a same-record collision) changed nothing — no reason to refresh.
  if (result?.succeeded) refreshAfterWrite(deps);
}

async function dispatchAbsorb(deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange): Promise<void> {
  const result = await deps.controller.absorbUpstreamUpdate(item.plugin, item.origin);
  if (result && isRefused(result)) { deps.showError(result.message); return; }
  if (!result?.succeeded) {
    // A refusal rides a 200, which the WriteRefused check above never sees — unsurfaced it
    // leaves the plugin unabsorbed and still read-only with nothing saying why (ADR-0026).
    if (result) {
      deps.log?.(`[externalChangeGestures] absorbUpstreamUpdate(${item.plugin}) refused: ${result.refusalReason ?? ''}`);
      deps.showError(`mEdit: Could not absorb the upstream update for "${item.plugin}" — ${result.refusalReason ?? ''}`);
    }
    return;
  }
  refreshAfterWrite(deps);

  const choice = await deps.showRebaseOffer(rebaseOfferMessage(item.origin), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
  if (choice !== REBASE_NOW_BUTTON) return; // 'Later' — the branch stays honestly behind main.

  await runRebase(deps, item.origin);
}

async function dispatchOne(
  deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange, answer: ExternalChangeDialogAnswer,
): Promise<void> {
  // 'defer' (Esc/dismiss) writes nothing and calls nothing: the backend's queue still holds the
  // question, so the next detection (a live change, or the next load-time check) asks it again.
  if (answer === 'defer') return;
  if (answer === 'keep') return dispatchKeep(deps, item);
  return dispatchAbsorb(deps, item);
}

// Origin-scoped: the repo, not any one plugin, is the unit of baselines and rebase. Resumption-aware
// (a conflicted rebase re-runs this), shared by the manual Rebase gesture and the
// Absorb-then-offer-rebase follow-on above.
export async function runRebase(
  deps: Pick<ExternalChangeCoordinatorDeps, 'controller' | 'openMergeEditor' | 'showError' | 'refreshTree' | 'refreshMatchingPlugins'>,
  origin: string,
): Promise<RebaseResult | null> {
  const result = await deps.controller.rebaseOntoMain(origin);
  if (!result) return null;
  if (isRefused(result)) { deps.showError(result.message); return null; }
  if (result.outcome === 'Conflicted') {
    for (const path of result.conflictedPaths) {
      await deps.openMergeEditor(origin, path);
    }
  }
  // Refresh happens either way — `Conflicted` leaves the repo mid-rebase, which the panel must
  // reflect.
  refreshAfterWrite(deps);
  return result;
}

/** ADR-0046 invariant 12: the plugin watcher's signal drives the one dialog directly — no poll,
 *  no health gate, since `notificationSubscriber` already follows the backend's lifecycle.
 *  Returns the unsubscribe. */
export function wireExternalChangePending(
  client: Pick<MEditClient, 'getPlugins' | 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>,
  outputChannel: vscode.LogOutputChannel,
  notificationSubscriber: NotificationSubscriber, treeProvider: PluginTreeProvider, refreshMatchingPlugins: () => void,
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
