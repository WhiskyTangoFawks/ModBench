import { isCrashRepairReason, type CrashRepairOffer, type MEditClient, type UnansweredExternalChange } from '../client';
import type { AskQuestion } from '../ports/dialog';
import { handleUnanswered } from './externalChangeGestures';
import { errorMessage } from '../ports/errorMessage';

export type OpenMergeEditor = (origin: string, relativePath: string) => Thenable<unknown> | Promise<unknown>;

export interface ExternalChangeCoordinatorDeps {
  // The three write verbs Keep/Absorb/Rebase dispatch to, narrowed off the port (ADR-0002).
  client: Pick<MEditClient, 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>;
  showDialog: AskQuestion;
  openMergeEditor: OpenMergeEditor;
  /** ADR-0019: the gesture's own refusal, verbatim — Keep/Absorb/Rebase share this one surface. */
  showError: (message: string) => void;
  /** A landed Keep/Absorb/Rebase is a working-tree change (ADR-0017). */
  refreshTree: () => void;
  refreshMatchingPlugins: () => void;
  /** The other question-open verdict: a repair offer, never Absorb/Keep's own dialog. */
  presentCrashRepair: (offers: CrashRepairOffer[]) => Promise<void>;
  log?: (msg: string) => void;
}

// Decides *when* to raise the dialog (ADR-0014 invariant 2: the plugin watcher's own signal,
// no poll); the dialog and the gestures it dispatches to are the Plugins view's
// (plugins/externalChangeGestures.ts). Returns the unsubscribe function.
export function subscribeQuestionOpen(
  deps: ExternalChangeCoordinatorDeps, notificationSubscriber: Pick<MEditClient, 'subscribe'>,
): () => void {
  const log = deps.log ?? (() => {});
  return notificationSubscriber.subscribe('question-open', (event) => {
    // Never both: a genuine external change and a repair offer are the two verdicts one
    // question-open notification carries, one or the other.
    if (event.crashRepairReason && isCrashRepairReason(event.crashRepairReason)) {
      const reason = event.crashRepairReason;
      const offers: CrashRepairOffer[] = event.keys.map((plugin) => ({ plugin, origin: event.origin, reason }));
      deps.presentCrashRepair(offers).catch((e: unknown) => {
        log(`[externalChangeCoordinator] presenting the repair offer for ${event.origin} failed: ${errorMessage(e)}`);
      });
      return;
    }
    // `keys` carries the changed plugin names — the generic field every notification kind
    // already has, repurposed rather than a second copy of the same list.
    const change: UnansweredExternalChange = {
      origin: event.origin,
      plugins: event.keys,
      trackedFiles: event.externalChangeTrackedFiles ?? [],
      metaChanged: event.externalChangeMetaChanged ?? false,
      oldVersion: event.externalChangeOldVersion ?? null,
      newVersion: event.externalChangeNewVersion ?? null,
    };
    // ADR-0019: a dialog/dispatch failure gets a log line, never a second toast on top of
    // whatever the dialog or the mutate call already surfaced.
    handleUnanswered(deps, [change]).catch((e: unknown) => {
      log(`[externalChangeCoordinator] handling ${change.origin} failed: ${errorMessage(e)}`);
    });
  });
}
