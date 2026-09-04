import type { PluginRepository } from './PluginRepository';
import type { EditingController } from './EditingController';
import type { ExternalChangeDialogAnswer, ShowExternalChangeDialog } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { UnansweredExternalChange, RebaseResult } from './ApiClient';

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
  repository: PluginRepository;
  controller: EditingController;
  showDialog: ShowExternalChangeDialog;
  showRebaseOffer: ShowRebaseOffer;
  openMergeEditor: OpenMergeEditor;
  log?: (msg: string) => void;
}

/** Slower than the reconcile poller: an external change is rare and never latency-sensitive,
 *  so there is no reason to poll at that cadence. */
export const EXTERNAL_CHANGE_POLL_INTERVAL_MS = 3000;

/** Self-rescheduling `setTimeout` rather than an interval, so a slow poll — or a dialog the
 *  user leaves open — can never stack ticks behind itself. Returns a stop function. */
export function startExternalChangePolling(
  deps: ExternalChangeCoordinatorDeps, intervalMs = EXTERNAL_CHANGE_POLL_INTERVAL_MS,
): () => void {
  const log = deps.log ?? (() => {});
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async () => {
    try {
      const unanswered = await deps.repository.getExternalChangeStatus();
      if (!stopped && unanswered.length > 0) await handleUnanswered(deps, unanswered);
    } catch (e) {
      // ADR-0026 background/recoverable tier: a poll blip gets a log line and the next tick, same
      // posture as every other poller in this codebase — never a toast for a transient failure to
      // ask "is anything unanswered".
      log(`[externalChangeCoordinator] poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

export interface ExternalChangePollerGateDeps {
  onBackendStatusChange: (cb: () => void) => void;
  /** Read fresh inside the callback: the emitted status string and `isHealthy` are two separate
   *  reads on the real `BackendManager`. */
  isBackendHealthy: () => boolean;
  startPolling: () => () => void;
}

/** Tied to the backend's process lifecycle, not extension activation: polling before a backend
 *  exists is a `poll failed` line every tick. Health alone gates it — a load-order-less backend
 *  answers the endpoint anyway. */
export function gateExternalChangePolling(deps: ExternalChangePollerGateDeps): void {
  let stop: (() => void) | undefined;
  deps.onBackendStatusChange(() => {
    if (deps.isBackendHealthy()) {
      stop ??= deps.startPolling();
    } else {
      stop?.();
      stop = undefined;
    }
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
