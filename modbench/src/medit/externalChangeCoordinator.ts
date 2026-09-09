import type { EditingController } from './EditingController';
import type { ShowExternalChangeDialog } from '../plugins/externalChangeDialog';
import type { UnansweredExternalChange } from './ApiClient';
import type { NotificationSubscriber } from './NotificationSubscriber';
import { handleUnanswered, type ShowRebaseOffer } from '../plugins/externalChangeGestures';

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

// Decides *when* to raise the dialog (ADR-0046 invariant 12: the plugin watcher's own signal,
// no poll); the dialog and the gestures it dispatches to are the Plugins view's
// (plugins/externalChangeGestures.ts). Returns the unsubscribe function.
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
