import { isCrashRepairReason, type CrashRepairOffer, type MEditClient, type UnansweredExternalChange } from '../client';
import type { AskQuestion } from '../ports/dialog';
import type { Reporter } from '../ports/reporter';
import { askOne, dispatchOne } from './externalChangeGestures';
import { errorMessage } from '../ports/errorMessage';

export type OpenMergeEditor = (origin: string, relativePath: string) => Thenable<unknown> | Promise<unknown>;

export interface ExternalChangeCoordinatorDeps {
  // The three write verbs Keep/Absorb/Rebase dispatch to, narrowed off the port (ADR-0002).
  client: Pick<MEditClient, 'keepAsMyEdit' | 'absorbUpstreamUpdate' | 'rebaseOntoMain'>;
  showDialog: AskQuestion;
  openMergeEditor: OpenMergeEditor;
  /** ADR-0019: each gesture's refusal, and each plugin of Absorb's answer that did not land. */
  reporter: Pick<Reporter, 'report' | 'selectionOutcome'>;
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
  const ask = oneDialogAtATime(deps, log);
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
    ask(change);
  });
}

// ADR-0003, invariant 3: one dialog asks per mod, and a modal is never shown twice at once. A
// settle can split one release into questions; one that arrives while its mod's dialog is open
// waits, and an answer given over part of the release is asked again over the whole.
function oneDialogAtATime(deps: ExternalChangeCoordinatorDeps, log: (msg: string) => void): (change: UnansweredExternalChange) => void {
  const waiting = new Map<string, UnansweredExternalChange>();
  let asking = false;
  const answerEach = async (): Promise<void> => {
    for (let next = waiting.values().next(); !next.done; next = waiting.values().next()) {
      let change = next.value;
      waiting.delete(change.origin);
      let answer = await askOne(deps, change);
      for (let later = waiting.get(change.origin); later !== undefined; later = waiting.get(change.origin)) {
        waiting.delete(change.origin);
        if (answer === 'defer') break;
        change = later;
        answer = await askOne(deps, change);
      }
      await dispatchOne(deps, change.origin, answer);
    }
  };
  return (change) => {
    waiting.set(change.origin, change);
    if (asking) return;
    asking = true;
    // ADR-0019: a dialog/dispatch failure gets a log line, never a second toast on top of
    // whatever the dialog or the mutate call already surfaced.
    answerEach()
      .catch((e: unknown) => { log(`[externalChangeCoordinator] handling ${change.origin} failed: ${errorMessage(e)}`); })
      .finally(() => { asking = false; });
  };
}
