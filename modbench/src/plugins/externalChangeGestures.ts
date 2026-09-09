import type { ExternalChangeDialogAnswer } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import type { UnansweredExternalChange, RebaseResult } from '../medit/ApiClient';
import { isRefused } from '../medit/client';
import type { ExternalChangeCoordinatorDeps } from '../medit/externalChangeCoordinator';

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
