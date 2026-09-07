import type { EditingController } from './EditingController';
import type { ExternalChangeDialogAnswer, ShowExternalChangeDialog } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { UnansweredExternalChange, RebaseResult } from './ApiClient';
import type { NotificationSubscriber } from './NotificationSubscriber';

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

/** `origin` rides along explicitly because re-deriving it from the unanswered queue when the
 *  merge editor opens would race the very MarkAnswered call that caused this rebase. */
export type OpenMergeEditor = (origin: string, relativePath: string) => Thenable<unknown> | Promise<unknown>;

export interface ExternalChangeCoordinatorDeps {
  controller: EditingController;
  showDialog: ShowExternalChangeDialog;
  showRebaseOffer: ShowRebaseOffer;
  openMergeEditor: OpenMergeEditor;
  log?: (msg: string) => void;
}

/** ADR-0046 invariant 12: the plugin watcher's own signal becomes this dialog directly, no poll.
 *  One notification is one queued question, run through the same sequential dialog path a
 *  poll's batch would have. Returns the unsubscribe function. */
export function subscribeExternalChangePending(
  deps: ExternalChangeCoordinatorDeps, notificationSubscriber: NotificationSubscriber,
): () => void {
  const log = deps.log ?? (() => {});
  return notificationSubscriber.subscribe('external-change-pending', (event) => {
    const change: UnansweredExternalChange = {
      plugin: event.plugin,
      origin: event.origin,
      metaChanged: event.externalChangeMetaChanged ?? false,
      oldVersion: event.externalChangeOldVersion ?? null,
      newVersion: event.externalChangeNewVersion ?? null,
    };
    // ADR-0026: a dialog/dispatch failure gets a log line, never a second toast on top of
    // whatever the dialog or the mutate call already surfaced.
    handleUnanswered(deps, [change]).catch((e: unknown) => {
      log(`[externalChangeCoordinator] handling ${change.plugin} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
}

async function handleUnanswered(deps: ExternalChangeCoordinatorDeps, unanswered: UnansweredExternalChange[]): Promise<void> {
  const outcomes = await runExternalChangeDialogs(unanswered, deps.showDialog);
  for (const { change: item, answer } of outcomes) {
    // Sequential, deliberately: two dispatches for one repository (two plugins in the same folder
    // can both be queued) must not overlap a rebase offer against an absorb still in flight.
    await dispatchOne(deps, item, answer);
  }
}

async function dispatchOne(
  deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange, answer: ExternalChangeDialogAnswer,
): Promise<void> {
  // 'defer' (Esc/dismiss) writes nothing and calls nothing: the backend's queue still holds the
  // question, so the next poll tick asks it again.
  if (answer === 'defer') return;

  if (answer === 'keep') {
    await deps.controller.keepAsMyEdit(item.plugin, item.origin);
    return;
  }

  const result = await deps.controller.absorbUpstreamUpdate(item.plugin, item.origin);
  if (!result?.succeeded) return;

  const choice = await deps.showRebaseOffer(rebaseOfferMessage(item.origin), REBASE_NOW_BUTTON, REBASE_LATER_BUTTON);
  if (choice !== REBASE_NOW_BUTTON) return; // 'Later' — the branch stays honestly behind main.

  await runRebase(deps, item.origin);
}

export async function runRebase(deps: Pick<ExternalChangeCoordinatorDeps, 'controller' | 'openMergeEditor'>, origin: string): Promise<RebaseResult | null> {
  const result = await deps.controller.rebaseOntoMain(origin);
  if (result?.outcome === 'Conflicted') {
    for (const path of result.conflictedPaths) {
      await deps.openMergeEditor(origin, path);
    }
  }
  return result;
}
