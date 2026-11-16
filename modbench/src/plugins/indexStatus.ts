import type * as vscode from 'vscode';
import { isMEditGone, type RecordIndexStanding, type MEditClient, type PluginLoadFailure } from '../client';
import type { Reporter } from '../ports/reporter';
import type { PluginsViewProgress } from './pluginRowCommands';
import type { PluginFactsFeed } from './pluginFactsFeed';
import { reportSkippedPlugins } from './pluginFailures';
import { createReconcileNarrator, type ReconcileNarrator } from './reconcileNarrator';
import type { StatusBar } from './statusBar';

interface ReconciledDeps {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  statusBar: Pick<StatusBar, 'ready'>;
  registerRepositories: () => void;
  /** The completed reconcile's whole hand-off to the tree, so no caller can apply one part of
   *  it without the rest. */
  applyReconciled: (failures: PluginLoadFailure[], totalPlugins: number) => Promise<void>;
}

// Ready is only published once the snapshot is indexed (common.md, The status bar, story 1),
// so conflicts are computed.
async function settleReconciled(status: RecordIndexStanding, deps: ReconciledDeps): Promise<void> {
  reportSkippedPlugins(status.failures, deps);
  deps.statusBar.ready(status.activePlugins);
  deps.registerRepositories();
  await deps.applyReconciled(status.failures, status.totalPlugins);
}

// plugins.md, States 3: the tree's own wording for a row not yet held while mEdit is unreachable.
const UNREACHABLE_REASON = {
  disconnected: 'mEdit is disconnected.',
  stopped: 'mEdit is stopped.',
};

interface IndexStatusDeps {
  client: Pick<MEditClient, 'recordIndexStanding' | 'onDidChange' | 'onDidChangeRecordIndexProgress' | 'onStatusChanged'>;
  facts: Pick<PluginFactsFeed, 'indexed' | 'refused' | 'reconciled' | 'unreachable' | 'refresh'>;
  progress: PluginsViewProgress;
  statusBar: Pick<StatusBar, 'ready' | 'showMEditState'>;
  registerRepositories: () => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporter: Reporter;
}

// plugins.md, States 2–4 and 6: the record index status the stream carries drives the Plugins view,
// whoever started the reconcile. mEdit going away, or a stream reopening onto another process,
// starts its versions over.
export function followIndexStatus(deps: IndexStatusDeps): { narrator: ReconcileNarrator } & vscode.Disposable {
  const { client, facts, progress, statusBar, registerRepositories, log, reporter } = deps;
  const info = (m: string) => log('info', `[loadOrder] ${m}`);
  const warn = (m: string) => reporter.report('warning', m);
  const narrator = createReconcileNarrator({
    showProgress: (until) => void progress.while(() => until),
    applyIndexed: (indexedPlugins, failures) => {
      facts.indexed(indexedPlugins, failures);
      statusBar.showMEditState();
    },
    applyRefused: (refusal) => {
      facts.refused(refusal);
      statusBar.showMEditState();
    },
    settle: (status) => settleReconciled(status, {
      log: info, warn, statusBar, registerRepositories,
      applyReconciled: (failures, totalPlugins) => applyReconciled(deps, failures, totalPlugins),
    }),
    log: (m) => log('error', `[loadOrder] ${m}`),
  });
  let lastHeardStatus: RecordIndexStanding | undefined;
  const hearCurrent = (): void => {
    const status = client.recordIndexStanding;
    if (status === lastHeardStatus) return;
    lastHeardStatus = status;
    if (status) narrator.hear(status); else narrator.detached();
  };
  const progressSubscription = client.onDidChangeRecordIndexProgress(hearCurrent);
  const changeSubscription = client.onDidChange(hearCurrent);
  const unsubscribes = [
    () => { progressSubscription.dispose(); changeSubscription.dispose(); },
    client.onStatusChanged((status) => {
      hearCurrent();
      if (!isMEditGone(status)) return;
      // ADR-0002: the rows stay, and expand into the error row.
      void facts.refresh();
      facts.unreachable(UNREACHABLE_REASON[status]);
    }),
  ];
  return { narrator, dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); } };
}

async function applyReconciled(
  { facts, log }: IndexStatusDeps,
  failures: PluginLoadFailure[],
  // Carried in only to be logged next to what reached the tree. Deliberately not the snapshot's
  // plugin count: that omits the implicit masters the backend prepends, so every healthy
  // reconcile would read as short.
  totalPlugins: number,
): Promise<void> {
  const held = await facts.reconciled(failures);
  // Superseded by a newer step, which shows its own state, or a failed read the feed reported.
  if (held === undefined) return;
  // Do not remove as logging noise: `held + failures.length` landing close to
  // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
  log('info', `[loadOrder] applying reconciled load order to tree: ${held} in the load order, ${failures.length} failed, of ${totalPlugins} plugins`);
}
