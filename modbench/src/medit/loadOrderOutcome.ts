import type {
  LoadOrderOutcome, LoadOrderPluginInput, PluginLoadFailure, WriteRefused,
} from '../client';
import { isRefused } from '../client';
import { reportIndexRefusal } from './loadOrderProgress';
import { reportSkippedPlugins } from './pluginFailures';
import { errorMessage } from '../ports/errorMessage';

/** Each callback is exactly one ADR-0019 surface — `warn`/`error` toast, `log` writes the
 *  channel, `setStatusText` writes the status bar, `notifyConflictsComputed` fires once,
 *  `refreshTree` re-reads the record browser's own caches. */
export interface LoadOrderOutcomeDeps {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  setStatusText: (text: string) => void;
  notifyConflictsComputed: () => void;
  refreshTree: () => void;
}

/** Everything a settled `putLoadOrder` needs reported, testable without a VS Code harness.
 *  `abandoned` reports nothing — a superseded or closed reconcile owns no view. `failures` is
 *  the caller's own last progress tick, never this outcome's. */
export function reportLoadOrderResult(
  plugins: LoadOrderPluginInput[],
  result: LoadOrderOutcome,
  failures: PluginLoadFailure[],
  deps: LoadOrderOutcomeDeps,
): void {
  if (result.outcome === 'failed') {
    deps.error(result.message);
    return;
  }
  if (result.outcome !== 'applied') return; // 'abandoned'
  // A terminal refusal: the status bar carries it, and nothing here claims Ready over it.
  if (reportIndexRefusal(result.status, deps)) return;

  reportSkippedPlugins(failures, deps);
  // Participation is derived — enabled AND winning AND listed — and the snapshot is every copy,
  // so a non-empty one can still have nothing that participates (ADR-0013).
  if (!plugins.some((p) => p.enabled && p.winning && p.slot !== null)) {
    deps.warn(
      'mEdit: The active profile has no enabled plugins — only base-game masters are held. ' +
        'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
    );
  }
  deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugin copies)`);
  // A reconciled load order can move which records a row's page/interior/reference caches hold,
  // so the record browser re-reads them the same as any other write (ADR-0002).
  deps.refreshTree();
  // The backend answers this PUT only after the winner sweep, so reaching here *is* "conflicts
  // are computed" (ADR-0013).
  deps.notifyConflictsComputed();
}

/** The two steps a settled load order still owes its surfaces, each injected so this file stays
 *  free of `vscode`. A repair offer is the question-open coordinator's own affair now. */
export interface LoadOrderApplyDeps extends LoadOrderOutcomeDeps {
  syncFilterState: () => Promise<void>;
  /** The completed reconcile's whole hand-off to the tree, so no caller can apply one part of
   *  it without the rest. */
  applyReconciled: (failures: PluginLoadFailure[], totalPlugins: number) => Promise<void>;
}

/** ADR-0013: a settled PUT, reported and then applied. `failures`/`totalPlugins` are the
 *  caller's own last progress tick, never read off `result`. */
export async function applyLoadOrderOutcome(
  plugins: LoadOrderPluginInput[],
  result: LoadOrderOutcome,
  failures: PluginLoadFailure[],
  totalPlugins: number,
  deps: LoadOrderApplyDeps,
): Promise<void> {
  reportLoadOrderResult(plugins, result, failures, deps);
  // A terminal refusal is not ready: neither the filter sync nor the tree's own hand-off is the
  // completed reconcile's, since there was none.
  if (result.outcome !== 'applied' || result.status.refusalMessage !== undefined) return;
  await deps.syncFilterState();
  await deps.applyReconciled(failures, totalPlugins);
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
