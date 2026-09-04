import type { MarkdownString } from 'vscode';

// Both are statements about a live backend, so both clear together: a tracked set outliving it
// would keep offering Change FormID on rows nothing backs.
interface RecordBrowserSets {
  setImmutablePlugins(names: string[]): void;
  setTrackedPlugins(names: string[]): void;
}

/** Stated structurally so this file imports from neither bounded context and needs no VS Code
 *  harness to test; `extension.ts`'s real session satisfies it by shape. */
export interface TeardownSession {
  loadOrderSync?: { abandon(): void; setMatches(map: Map<string, boolean> | undefined): void };
  pluginsTree?: { setLoadOrder(files: undefined): void; refreshDecorations(): void };
  pluginsTreeView?: { message?: string | MarkdownString };
  pluginsNameFilter?: { refresh(): void };
  recordBrowserProvider?: RecordBrowserSets;
  backendManager?: { isHealthy: boolean; on(event: 'status', cb: () => void): void; stop(): Promise<void> };
  setFilterActive?: (active: boolean) => void;
  /** Cleared by both teardown writers below so the two diagnosis surfaces — Problems entries and
   *  the tree badge — can never disagree about a dead session. */
  loadDiagnostics?: { clear(): void };
}

/** `TreeView.message` is the native surface for a view-scoped statement about its own contents,
 *  so there is no banner row and no bespoke widget. */
export function say(session: TeardownSession, message: string | undefined): void {
  if (!session.pluginsTreeView) return;
  session.pluginsTreeView.message = message;
  // One message surface, two things that can want it: when the load stops talking, whatever the
  // name filter had to say comes back rather than staying silently swallowed.
  if (message === undefined) session.pluginsNameFilter?.refresh();
}

/** There is no separate loadout view mode to switch back to: the loadout views are never hidden,
 *  and Referenced By governs its own visibility. */
export function exitToLoadout(session: TeardownSession): void {
  // Abandon any reconcile still in flight *first*: it aborts the PUT, so the reconcile returns
  // 'abandoned' rather than reporting a killed backend to the user as a network failure.
  session.loadOrderSync?.abandon();
  // The chevrons go with the backend. Cleared before it stops, so no row can be expanded
  // into a backend that is on its way down. The immutable set goes with it.
  session.pluginsTree?.setLoadOrder(undefined);
  // So does anything the reconcile was saying about itself: a statement about a load order that
  // is not held is the same class of silent-wrong-state as a stale chevron.
  say(session, undefined);
  // And so does the record filter's whole UI state, through the same single writer every other
  // record-filter change goes through, so `modbench.filterActive` has exactly one writer.
  session.setFilterActive?.(false);
  // And so does the match set it drove (ADR-0035) — a statement about which held plugins' records
  // matched, same reasoning as the chevrons just above.
  session.loadOrderSync?.setMatches(undefined);
  session.recordBrowserProvider?.setImmutablePlugins([]);
  session.recordBrowserProvider?.setTrackedPlugins([]);
  // The Problems entries are statements about a live backend's scan, same as the tree badge
  // setLoadOrder just cleared.
  session.loadDiagnostics?.clear();
  // stop()'s body runs to completion whether or not the returned promise is awaited, so
  // fire-and-forget still defers emitStatus('stopped') correctly.
  void session.backendManager?.stop();
}

/** A backend that dies takes the load order with it, and `exitToLoadout` is not on that path — a
 *  crash reaches us only as a status change. Otherwise rows keep chevrons that fetch against a
 *  backend that is gone. */
export function clearTreeWhenBackendDies(
  session: TeardownSession,
  composite: { setLoadOrder(files: undefined): void },
  recordBrowser: RecordBrowserSets,
): void {
  session.backendManager?.on('status', () => {
    if (session.backendManager?.isHealthy) return;
    composite.setLoadOrder(undefined);
    recordBrowser.setImmutablePlugins([]);
    recordBrowser.setTrackedPlugins([]);
    // Same reasoning as the two above: a statement about which plugins the dead backend's records
    // matched must not seed the next one.
    session.loadOrderSync?.setMatches(undefined);
    // And neither must its diagnoses.
    session.loadDiagnostics?.clear();
  });
}

/** Re-derives the match map off a fresh `GET /plugins`, so the chevron reads the filter active
 *  now. A read failure degrades to "no data" (matches everywhere) rather than throwing: briefly
 *  over-showing chevrons beats silently freezing every one. */
export async function refreshMatchingPlugins(
  session: TeardownSession,
  repository: { getPlugins(): Promise<{ name: string; inLoadOrder: boolean; hasMatchingRecords: boolean }[]> },
  channel: { error(msg: string): void },
): Promise<void> {
  try {
    // ADR-0044: keyed by filename, so read the copy plugins.txt names — two held copies can share one.
    const plugins = (await repository.getPlugins()).filter((p) => p.inLoadOrder);
    session.loadOrderSync?.setMatches(new Map(plugins.map((p) => [p.name.toLowerCase(), p.hasMatchingRecords] as const)));
  } catch (err) {
    channel.error(`[extension] refreshing the record filter's plugin matches failed: ${err instanceof Error ? err.message : String(err)}`);
    session.loadOrderSync?.setMatches(undefined);
  }
  session.pluginsTree?.refreshDecorations();
}
