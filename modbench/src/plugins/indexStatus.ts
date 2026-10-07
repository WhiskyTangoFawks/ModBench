import type * as vscode from 'vscode';
import { isMEditGone, type LoadOrderProgress, type MEditClient, type PluginLoadFailure, type RecordFilter } from '../client';
import { errorMessage } from '../ports/errorMessage';
import type { Reporter } from '../ports/reporter';
import type { PluginsViewProgress } from './pluginRowCommands';
import type { PluginsTreeProvider } from './PluginsTreeProvider';
import type { PluginTreeProvider } from './PluginTreeProvider';
import { reportSkippedPlugins } from './pluginFailures';
import { createReconcileNarrator, subscribeNarratorToLoadOrderStatus, type ReconcileNarrator } from './reconcileNarrator';
import type { StatusBar } from './statusBar';

interface ReconciledDeps {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  statusBar: Pick<StatusBar, 'ready'>;
  notifyConflictsComputed: () => void;
  refreshTree: () => void;
  syncFilterState: () => Promise<void>;
  /** The completed reconcile's whole hand-off to the tree, so no caller can apply one part of
   *  it without the rest. */
  applyReconciled: (failures: PluginLoadFailure[], totalPlugins: number) => Promise<void>;
}

// A reconcile that reached Ready, whoever started it, reported and then handed to the views.
// Ready is only published once the snapshot is indexed (common.md, The status bar, story 1),
// so conflicts are computed.
async function settleReconciled(status: LoadOrderProgress, deps: ReconciledDeps): Promise<void> {
  reportSkippedPlugins(status.failures, deps);
  deps.statusBar.ready(status.activePlugins);
  // A reconciled load order can move which records a row's page/interior/reference caches hold,
  // so the record browser re-reads them the same as any other write.
  deps.refreshTree();
  deps.notifyConflictsComputed();
  await deps.syncFilterState();
  await deps.applyReconciled(status.failures, status.totalPlugins);
}

// A read failure logs and warns, and never throws (ADR-0019). The filter clears only on purpose
// (plugins.md, Order and view state, story 3), so a failed read leaves the view as it was.
async function syncActiveFilter(
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

// plugins.md, States 3: the tree's own wording for a row not yet held while mEdit is unreachable.
const UNREACHABLE_REASON = {
  disconnected: 'mEdit is disconnected.',
  stopped: 'mEdit is stopped.',
};

export interface IndexStatusDeps {
  client: Pick<MEditClient, 'onNotification' | 'onStatusChanged' | 'onReconnected' | 'getActiveFilter'>;
  tree: Pick<PluginsTreeProvider,
    'applyIndexed' | 'applyRefused' | 'applyReconciled' | 'applyBackendUnreachable' | 'refreshFacts'>;
  /** The record browser a reconciled load order refreshes. */
  recordBrowser: Pick<PluginTreeProvider, 'refresh'>;
  progress: PluginsViewProgress;
  statusBar: Pick<StatusBar, 'ready' | 'showMEditState'>;
  showRecordFilter: (filter: RecordFilter | null) => void;
  notifyConflictsComputed: () => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporter: Reporter;
}

// plugins.md, States 2–4 and 6: the index status the stream carries drives the Plugins view,
// whoever started the reconcile. mEdit going away, or a stream reopening onto another process,
// starts its versions over.
export function followIndexStatus(deps: IndexStatusDeps): { narrator: ReconcileNarrator } & vscode.Disposable {
  const { client, tree, recordBrowser, progress, statusBar, showRecordFilter, notifyConflictsComputed, log, reporter } = deps;
  const info = (m: string) => log('info', `[loadOrder] ${m}`);
  const warn = (m: string) => reporter.report('warning', m);
  const narrator = createReconcileNarrator({
    showProgress: (until) => void progress.while(() => until),
    applyIndexed: (indexedPlugins, failures) => {
      tree.applyIndexed(indexedPlugins, failures);
      statusBar.showMEditState();
    },
    applyRefused: (refusal) => {
      tree.applyRefused(refusal);
      statusBar.showMEditState();
    },
    settle: (status) => settleReconciled(status, {
      log: info, warn, statusBar, notifyConflictsComputed,
      refreshTree: () => recordBrowser.refresh(),
      syncFilterState: () => syncActiveFilter(() => client.getActiveFilter(), { log: info, warn, showRecordFilter }),
      applyReconciled: (failures, totalPlugins) => applyReconciled(deps, failures, totalPlugins),
    }),
    log: (m) => log('error', `[loadOrder] ${m}`),
  });
  const unsubscribes = [
    subscribeNarratorToLoadOrderStatus(client, narrator),
    client.onStatusChanged((status) => {
      if (!isMEditGone(status)) return;
      narrator.detached();
      // ADR-0002: the rows stay, and expand into the error row.
      void tree.refreshFacts();
      tree.applyBackendUnreachable(UNREACHABLE_REASON[status]);
    }),
    client.onReconnected(() => narrator.detached()),
  ];
  return { narrator, dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); } };
}

async function applyReconciled(
  { tree, log, reporter }: IndexStatusDeps,
  failures: PluginLoadFailure[],
  // Carried in only to be logged next to what reached the tree. Deliberately not the snapshot's
  // plugin count: that omits the implicit masters the backend prepends, so every healthy
  // reconcile would read as short.
  totalPlugins: number,
): Promise<void> {
  const held = await tree.applyReconciled(failures);
  if (held === undefined) {
    // Leaving every row a leaf is a safe render but not an honest one: the reconcile did land,
    // so the tree would claim editing is unavailable with nothing on screen to say why (ADR-0019).
    log('error', '[loadOrder] the reconciled load order did not reach the tree; plugin rows will not expand');
    reporter.report(
      'warning',
      'The load order was reconciled, but the plugin list could not be read — plugin rows will not expand into records.',
    );
    return;
  }
  // Do not remove as logging noise: `held + failures.length` landing close to
  // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
  log('info', `[loadOrder] applying reconciled load order to tree: ${held} in the load order, ${failures.length} failed, of ${totalPlugins} plugins`);
}
