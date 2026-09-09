import type { MEditClient, UnansweredExternalChange } from './client';
import type { ShowExternalChangeDialog } from '../plugins/externalChangeDialog';
import { handleUnanswered, type ShowRebaseOffer } from '../plugins/externalChangeGestures';

/** `origin` rides along explicitly because re-deriving it from the unanswered queue when the
 *  merge editor opens would race the very MarkAnswered call that caused this rebase. */
export type OpenMergeEditor = (origin: string, relativePath: string) => Thenable<unknown> | Promise<unknown>;

export interface ExternalChangeCoordinatorDeps {
  // The three write verbs Keep/Absorb/Rebase dispatch to, narrowed off the port (ADR-0022) —
  // this module holds no controller.
  controller: Pick<MEditClient, 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>;
  showDialog: ShowExternalChangeDialog;
  showRebaseOffer: ShowRebaseOffer;
  openMergeEditor: OpenMergeEditor;
  /** ADR-0026: the gesture's own refusal, verbatim — Keep/Absorb/Rebase share this one surface. */
  showError: (message: string) => void;
  /** A landed Keep/Absorb/Rebase is a working-tree change (ADR-0035 amending ADR-0018). */
  refreshTree: () => void;
  refreshMatchingPlugins: () => void;
  log?: (msg: string) => void;
}

// Decides *when* to raise the dialog (ADR-0046 invariant 12: the plugin watcher's own signal,
// no poll); the dialog and the gestures it dispatches to are the Plugins view's
// (plugins/externalChangeGestures.ts). Returns the unsubscribe function.
export function subscribeExternalChangePending(
  deps: ExternalChangeCoordinatorDeps, notificationSubscriber: Pick<MEditClient, 'subscribe'>,
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
