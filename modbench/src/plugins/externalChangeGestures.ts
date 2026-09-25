import type { ExternalChangeDialogAnswer } from './externalChangeDialog';
import { runExternalChangeDialogs } from './externalChangeDialog';
import { isRefused, type UnansweredExternalChange, type RebaseResult } from '../client';
import type { ExternalChangeCoordinatorDeps } from './externalChangeCoordinator';

// The coordinator decides *when* to ask; this asks one mod's question and says what the answer
// was, and `dispatchOne` does what it asks — Absorb or Keep, origin-scoped (ADR-0003).
export async function askOne(
  deps: Pick<ExternalChangeCoordinatorDeps, 'showDialog'>, change: UnansweredExternalChange,
): Promise<ExternalChangeDialogAnswer> {
  const [outcome] = await runExternalChangeDialogs([change], deps.showDialog);
  return outcome?.answer ?? 'defer';
}

function refreshAfterWrite(deps: Pick<ExternalChangeCoordinatorDeps, 'refreshTree' | 'refreshMatchingPlugins'>): void {
  deps.refreshTree();
  deps.refreshMatchingPlugins();
}

// A typed refusal rides a 200 (`succeeded: false`), which each dispatcher's own WriteRefused
// check never sees — unsurfaced it leaves the mod unchanged and still read-only with nothing
// saying why (ADR-0019).
function reportTypedRefusal(
  deps: Pick<ExternalChangeCoordinatorDeps, 'log' | 'reporter'>,
  callName: string, origin: string, summary: string, refusalReason: string | null | undefined,
): void {
  deps.log?.(`[externalChangeGestures] ${callName}(${origin}) refused: ${refusalReason ?? ''}`);
  deps.reporter.report('error', `${summary} — ${refusalReason ?? ''}`);
}

async function dispatchKeep(deps: ExternalChangeCoordinatorDeps, origin: string): Promise<void> {
  const result = await deps.client.keepAsMyEdit(origin);
  if (result && isRefused(result)) { deps.reporter.report('error', result.message); return; }
  if (!result?.succeeded) {
    if (result) reportTypedRefusal(deps, 'keepAsMyEdit', origin, `Could not keep "${origin}" as your own edit`, result.refusalReason);
    return;
  }
  refreshAfterWrite(deps);
}

// ADR-0019: a partial answer is a partial save, so what did not land is named even when the rest
// did. The question stays open for it, and answering again finishes the update.
async function dispatchAbsorb(deps: ExternalChangeCoordinatorDeps, origin: string): Promise<void> {
  const result = await deps.client.absorbUpstreamUpdate(origin);
  if (isRefused(result)) { deps.reporter.report('error', result.message); return; }
  const total = result.landed.length + result.refused.length;
  deps.reporter.selectionOutcome(
    `Could not absorb ${result.refused.length} of ${total} plugins of the upstream update for "${origin}".`,
    result, (plugin) => plugin.name,
  );
  if (result.trackedFilesRefusal !== null) {
    deps.reporter.report(
      'error', `Could not commit the rest of the upstream update for "${origin}": every plugin landed.`, result.trackedFilesRefusal,
    );
  }
  const answered = result.refused.length === 0 && result.trackedFilesRefusal === null;
  if (result.landed.length > 0 || answered) refreshAfterWrite(deps);
}

export async function dispatchOne(
  deps: ExternalChangeCoordinatorDeps, origin: string, answer: ExternalChangeDialogAnswer,
): Promise<void> {
  // 'defer' (Esc/dismiss) writes nothing and calls nothing: the backend's queue still holds the
  // question, so the next detection (a live change, or the next load-time check) asks it again.
  if (answer === 'defer') return;
  if (answer === 'keep') return dispatchKeep(deps, origin);
  return dispatchAbsorb(deps, origin);
}

// The manual, re-runnable rebase gesture, origin-scoped: the repo, not any one plugin, is the unit
// of baselines and rebase. Resumption-aware — a conflicted rebase re-runs this.
export async function runRebase(
  deps: Pick<ExternalChangeCoordinatorDeps, 'client' | 'openMergeEditor' | 'reporter' | 'refreshTree' | 'refreshMatchingPlugins'>,
  origin: string,
): Promise<RebaseResult | null> {
  const result = await deps.client.rebaseOntoMain(origin);
  if (!result) return null;
  if (isRefused(result)) { deps.reporter.report('error', result.message); return null; }
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
