import type { LoadOrderOutcome, LoadOrderPluginInput, WriteRefused } from './client';
import { isRefused } from './client';
import { reportSkippedPlugins } from './pluginFailures';

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

/** Everything a settled `putLoadOrder` needs reported, pulled out of the load-order sync's own
 *  `vscode` wiring so it is testable without a VS Code harness. `abandoned` reports nothing —
 *  a superseded or closed reconcile owns no view to update. */
export function reportLoadOrderResult(
  plugins: LoadOrderPluginInput[],
  result: LoadOrderOutcome,
  deps: LoadOrderOutcomeDeps,
): void {
  if (result.outcome === 'failed') {
    deps.error(result.message);
    return;
  }
  if (result.outcome !== 'reconciled') return; // 'abandoned'

  reportSkippedPlugins(result.failures, deps);
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

/** What a synced filter read needs reported once it resolves — a read failure degrades to
 *  inactive and warns (never throws); otherwise the readout just states what the backend holds. */
export function applyFilterSyncResult(
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
    const detail = e instanceof Error ? e.message : String(e);
    deps.log(`syncing the active filter failed: ${detail}`);
    result = { refused: true, message: `mEdit: Could not read the active filter — treating the filter as inactive. ${detail}` };
  }
  applyFilterSyncResult(result, deps);
}
