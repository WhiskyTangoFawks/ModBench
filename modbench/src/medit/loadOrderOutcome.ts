import type {
  LoadOrderOutcome, LoadOrderPluginInput, LoadOrderProgress, PluginLoadFailure, WriteRefused,
} from '../client';
import { isRefused } from '../client';
import { reportSkippedPlugins } from './pluginFailures';
import { errorMessage } from '../ports/errorMessage';

/** What a put's own answer says apart from the reconcile it started: a send that failed, and a
 *  snapshot with nothing that participates. `abandoned` says nothing: a superseded or closed send
 *  owns no view. */
export function reportPutOutcome(
  plugins: LoadOrderPluginInput[],
  result: LoadOrderOutcome,
  deps: { warn: (msg: string) => void; error: (msg: string) => void },
): void {
  if (result.outcome === 'failed') {
    deps.error(result.message);
    return;
  }
  if (result.outcome !== 'applied' || result.status.refusalMessage !== undefined) return;
  // Participation is derived — enabled AND winning AND listed — and the snapshot is every copy,
  // so a non-empty one can still have nothing that participates (ADR-0013).
  if (!plugins.some((p) => p.enabled && p.winning && p.slot !== null)) {
    deps.warn(
      'mEdit: The active profile has no enabled plugins — only base-game masters are held. ' +
        'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
    );
  }
}

/** Each callback is exactly one ADR-0019 surface — `warn` toasts, `log` writes the channel,
 *  `setStatusText` writes the status bar, `notifyConflictsComputed` fires once, `refreshTree`
 *  re-reads the record browser's own caches. */
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

/** ADR-0013: a reconcile that reached Ready, whoever started it — reported, then handed to the
 *  views. Ready is only published after the winner sweep, so conflicts are computed. */
export async function settleReconciled(status: LoadOrderProgress, deps: ReconciledDeps): Promise<void> {
  reportSkippedPlugins(status.failures, deps);
  deps.setStatusText(`$(check) mEdit: Ready (${status.totalPlugins} plugin copies)`);
  // A reconciled load order can move which records a row's page/interior/reference caches hold,
  // so the record browser re-reads them the same as any other write (ADR-0002).
  deps.refreshTree();
  deps.notifyConflictsComputed();
  await deps.syncFilterState();
  await deps.applyReconciled(status.failures, status.totalPlugins);
}

// What a synced filter read needs reported once it resolves — a read failure degrades to
// inactive and warns (never throws); otherwise the readout just states what the backend holds.
function applyFilterSyncResult(
  result: string | null | WriteRefused,
  deps: { warn: (msg: string) => void; setFilterActive: (active: boolean, sql?: string, label?: string) => void },
): void {
  if (isRefused(result)) {
    deps.warn(result.message);
    deps.setFilterActive(false);
    return;
  }
  deps.setFilterActive(result !== null, result ?? undefined, undefined);
}

/** `getActiveFilter` is a plain port query with no `WriteRefused` wrapping of its own — this is
 *  that wrapping (ADR-0019: a read failure both logs and warns, never throws out of the sync). */
export async function syncActiveFilter(
  getActiveFilter: () => Promise<string | null>,
  deps: { log: (msg: string) => void; warn: (msg: string) => void; setFilterActive: (active: boolean, sql?: string, label?: string) => void },
): Promise<void> {
  let result: string | null | WriteRefused;
  try {
    result = await getActiveFilter();
  } catch (e) {
    const detail = errorMessage(e);
    deps.log(`syncing the active filter failed: ${detail}`);
    result = { refused: true, message: `mEdit: Could not read the active filter — treating the filter as inactive. ${detail}` };
  }
  applyFilterSyncResult(result, deps);
}
