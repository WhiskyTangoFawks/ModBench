import type { ExternalChangeDialogAnswer } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import { isRefused, type UnansweredExternalChange, type RebaseResult } from '../medit/client';
import type { ExternalChangeCoordinatorDeps } from '../medit/externalChangeCoordinator';

// The coordinator decides *when* to call this; this decides what each dialog answer does —
// Absorb Upstream Update or Keep as My Edit.
export async function handleUnanswered(deps: ExternalChangeCoordinatorDeps, unanswered: UnansweredExternalChange[]): Promise<void> {
  const outcomes = await runExternalChangeDialogs(unanswered, deps.showDialog);
  for (const { change: item, answer } of outcomes) {
    // Sequential, deliberately: two dispatches for one repository (two plugins in the same folder
    // can both be queued) must not overlap.
    await dispatchOne(deps, item, answer);
  }
}

function refreshAfterWrite(deps: Pick<ExternalChangeCoordinatorDeps, 'refreshTree' | 'refreshMatchingPlugins'>): void {
  deps.refreshTree();
  deps.refreshMatchingPlugins();
}

async function dispatchKeep(deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange): Promise<void> {
  const result = await deps.client.keepAsMyEdit(item.plugin, item.origin);
  if (result && isRefused(result)) { deps.showError(result.message); return; }
  // A refused Keep (a same-record collision) changed nothing — no reason to refresh.
  if (result?.succeeded) refreshAfterWrite(deps);
}

// Absorb's own rebase, run server-side in the same call: clean is silent, a refusal shows the
// ready-to-show reason (which names the dirty paths), a conflict opens the merge editor exactly
// as the manual rebase command does.
async function applyRebaseOutcome(
  deps: Pick<ExternalChangeCoordinatorDeps, 'openMergeEditor' | 'showError'>, origin: string, rebase: RebaseResult,
): Promise<void> {
  if (rebase.outcome === 'Refused') { deps.showError(rebase.refusalReason ?? 'Rebase refused.'); return; }
  if (rebase.outcome === 'Conflicted') {
    for (const path of rebase.conflictedPaths) await deps.openMergeEditor(origin, path);
  }
}

async function dispatchAbsorb(deps: ExternalChangeCoordinatorDeps, item: UnansweredExternalChange): Promise<void> {
  const result = await deps.client.absorbUpstreamUpdate(item.plugin, item.origin);
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
  if (result.rebase) await applyRebaseOutcome(deps, item.origin, result.rebase);
  refreshAfterWrite(deps);
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

// The manual, re-runnable rebase gesture, origin-scoped: the repo, not any one plugin, is the unit
// of baselines and rebase. Resumption-aware — a conflicted rebase re-runs this.
export async function runRebase(
  deps: Pick<ExternalChangeCoordinatorDeps, 'client' | 'openMergeEditor' | 'showError' | 'refreshTree' | 'refreshMatchingPlugins'>,
  origin: string,
): Promise<RebaseResult | null> {
  const result = await deps.client.rebaseOntoMain(origin);
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
