import type { LoadOrderOutcome, LoadOrderProgress, PluginLoadFailure, RecordFilter } from '../client';
import { reportSkippedPlugins } from './pluginFailures';
import { errorMessage } from '../ports/errorMessage';

/** What a put's own answer says apart from the reconcile it started: a send that failed.
 *  `abandoned` says nothing: a superseded or closed send owns no view. */
export function reportPutOutcome(result: LoadOrderOutcome, deps: { error: (msg: string) => void }): void {
  if (result.outcome === 'failed') deps.error(result.message);
}

export interface ReconciledDeps {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  setStatusText: (text: string) => void;
  notifyConflictsComputed: () => void;
  refreshTree: () => void;
  syncFilterState: () => Promise<void>;
  /** The completed reconcile's whole hand-off to the tree, so no caller can apply one part of
   *  it without the rest. */
  applyReconciled: (failures: PluginLoadFailure[], totalPlugins: number) => Promise<void>;
}

/** A reconcile that reached Ready, whoever started it, reported and then handed to the views.
 *  Ready is only published once the snapshot is indexed (common.md, The status bar, story 1),
 *  so conflicts are computed. */
export async function settleReconciled(status: LoadOrderProgress, deps: ReconciledDeps): Promise<void> {
  reportSkippedPlugins(status.failures, deps);
  deps.setStatusText(`$(check) mEdit: Ready (${status.activePlugins} plugins)`);
  // A reconciled load order can move which records a row's page/interior/reference caches hold,
  // so the record browser re-reads them the same as any other write.
  deps.refreshTree();
  deps.notifyConflictsComputed();
  await deps.syncFilterState();
  await deps.applyReconciled(status.failures, status.totalPlugins);
}

/** A read failure logs and warns, and never throws (ADR-0019). The filter clears only on purpose
 *  (plugins.md, Order and view state, story 3), so a failed read leaves the view as it was. */
export async function syncActiveFilter(
  getActiveFilter: () => Promise<RecordFilter | null>,
  deps: { log: (msg: string) => void; warn: (msg: string) => void; showRecordFilter: (filter: RecordFilter | null) => void },
): Promise<void> {
  let filter: RecordFilter | null;
  try {
    filter = await getActiveFilter();
  } catch (e) {
    const detail = errorMessage(e);
    deps.log(`syncing the record filter failed: ${detail}`);
    deps.warn(`Could not read the record filter — the Plugins view shows it as it last was. ${detail}`);
    return;
  }
  deps.showRecordFilter(filter);
}
