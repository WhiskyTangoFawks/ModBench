import type { MarkdownString } from 'vscode';

/** The two whole-load-order sets `PluginTreeProvider` renders record rows off (#674). Both are
 *  statements about a live backend, so both are cleared together everywhere below — a tracked set
 *  outliving its backend would keep offering Change FormID on rows nothing backs. */
interface RecordBrowserSets {
  setImmutablePlugins(names: string[]): void;
  setTrackedPlugins(names: string[]): void;
}

/** The slice of `ExtensionSession` this module's teardown/refresh writers touch, stated
 *  structurally so this file imports from neither bounded context and needs no VS Code
 *  harness to test (#650, folded into #628 — the same extracted-handler seam the checkbox
 *  handlers use). `extension.ts`'s real session satisfies it by shape. */
export interface TeardownSession {
  loadOrderSync?: { abandon(): void; setMatches(map: Map<string, boolean> | undefined): void };
  pluginsTree?: { setLoadOrder(files: undefined): void; refreshDecorations(): void };
  pluginsTreeView?: { message?: string | MarkdownString };
  pluginsNameFilter?: { refresh(): void };
  recordBrowserProvider?: RecordBrowserSets;
  backendManager?: { isHealthy: boolean; on(event: 'status', cb: () => void): void; stop(): Promise<void> };
  setFilterActive?: (active: boolean) => void;
  /** #570: the session-load diagnosis collection (Problems panel). Cleared by both teardown
   *  writers below so the two diagnosis surfaces — Problems entries and the tree badge, which
   *  `setLoadOrder(undefined)` clears — can never disagree about a dead session. */
  loadDiagnostics?: { clear(): void };
}

/** The Plugins view's own statement about what it is doing, or what it does not yet know
 *  (`TreeView.message` — the native surface for a view-scoped statement about its own contents,
 *  so there is no banner row and no bespoke widget). `undefined` clears it, which is the value
 *  the property itself takes. */
export function say(session: TeardownSession, message: string | undefined): void {
  if (!session.pluginsTreeView) return;
  session.pluginsTreeView.message = message;
  // One message surface, two things that can want it. The load's statement wins while it
  // has something to say; when it stops, whatever the name filter had to say comes back — a
  // no-matches statement must not be silently swallowed by a load that has since finished.
  if (message === undefined) session.pluginsNameFilter?.refresh();
}

/** Leave editing: tear down the editing backend. There is no separate loadout view mode
 *  to switch back to — the loadout views are never hidden, and Referenced By
 *  governs its own visibility. */
export function exitToLoadout(session: TeardownSession): void {
  // Abandon any reconcile still in flight *first* — it aborts the PUT outright, so the
  // reconcile stops polling and returns 'abandoned' rather than discovering a killed backend as a
  // network error and reporting that to the user as a failure.
  session.loadOrderSync?.abandon();
  // The chevrons go with the backend. Cleared before it stops, so no row can be expanded
  // into a backend that is on its way down. The immutable set goes with it.
  session.pluginsTree?.setLoadOrder(undefined);
  // So does anything the reconcile was saying about itself. A statement about a load order
  // that is no longer held is the same class of silent-wrong-state as a stale chevron.
  say(session, undefined);
  // And so does the record filter's whole UI state — the Clear action's context key,
  // the code lens's active SQL, and the Plugins tree readout's record-filter half — all through
  // the same single writer every other record-filter change goes through, so `modbench.filterActive`
  // stays written from exactly one place. (The name filter's half of the readout is untouched: it
  // filters load-order rows, which are still there.)
  session.setFilterActive?.(false);
  // And so does the match set it drove (ADR-0035 amending ADR-0018) — a statement about
  // which held plugins' records matched, same reasoning as the chevrons just above.
  session.loadOrderSync?.setMatches(undefined);
  session.recordBrowserProvider?.setImmutablePlugins([]);
  session.recordBrowserProvider?.setTrackedPlugins([]);
  // #570: the Problems entries are statements about a live backend's scan, same as the tree
  // badge setLoadOrder just cleared.
  session.loadDiagnostics?.clear();
  // stop() is async (waits for confirmed exit before reporting "stopped") but its body
  // runs to completion regardless of whether the returned promise is awaited — fire-and-forget
  // here still defers emitStatus('stopped') correctly; exitToLoadout() itself doesn't need to
  // become async just to observe that.
  void session.backendManager?.stop();
}

/** A backend that dies takes the load order with it, and `exitToLoadout` is not on that path — a
 *  crash or a lost connection reaches us only as a status change. Without this the rows keep their
 *  chevrons and expanding one fetches against a backend that is gone, and the record rows
 *  keep the read-only and tracked sets nothing backs. All are statements about a live backend, so they
 *  go together. */
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
    // ADR-0035 amending ADR-0018: same reasoning as the two above — a statement about
    // which plugins the dead backend's records matched must not seed the next one.
    session.loadOrderSync?.setMatches(undefined);
    // #570: and neither must its diagnoses (see exitToLoadout).
    session.loadDiagnostics?.clear();
  });
}

/** ADR-0035 amending ADR-0018: `EditingController.setFilter`/`clearFilter`'s
 *  `refreshMatchingPlugins` — re-derives `loadOrderSync`'s match map off a fresh `GET /plugins` and
 *  re-renders, so `PluginsTreeComposite`'s chevron reads the filter that is active now, not the
 *  one that produced the last set. The *other* path that can change which filter is active —
 *  a reconcile, which can start already-filtered or unfiltered — does not come through
 *  here; it is covered by `applyLoadOrderToTree` reusing this same `GET /plugins` answer via
 *  `HeldPluginFiles.matches`, not by a second call site into this function. A read
 *  failure here degrades to "no data" (matches everywhere) rather than throwing — a chevron guess
 *  is wrong in the same direction `hasMatchingRecords` already treats as safe, and a record
 *  filter's whole *point* is to be applied and inspected, so silently freezing every chevron would
 *  be a far worse failure than briefly over-showing them. */
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
