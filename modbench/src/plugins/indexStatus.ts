import type * as vscode from 'vscode';
import { isMEditGone, loadFailuresOf, type MEditClient, type PluginLoadFailure } from '../client';
import { isReadFailed } from '../wire/readFailed';
import type { Reporter } from '../ports/reporter';
import { tellingOnSurface } from '../drivingLib/tellingOnSurface';
import { pluginAddressKey } from '../wire/pluginAddress';
import { quotedPluginName } from '../wire/reasons';
import type { PluginsViewProgress } from './pluginRowCommands';
import type { PluginFactsFeed } from './pluginFactsFeed';
import { createReconcileNarrator, type Heard, type ReconcileNarrator } from './reconcileNarrator';
import type { StatusBar } from './statusBar';

interface ReconciledDeps {
  tellLanded: (failures: readonly PluginLoadFailure[], rowsGone: readonly PluginLoadFailure[]) => void;
  tellHeard: (failures: readonly PluginLoadFailure[]) => void;
  statusBar: Pick<StatusBar, 'ready'>;
  registerRepositories: () => void;
  /** The completed reconcile's whole hand-off to the tree, so no caller applies one part without the rest. Answers
   *  how many plugins are active and each failure that took away rows that stood; none when it did not land. */
  applyReconciled: (failures: readonly PluginLoadFailure[], totalPlugins: number) => Promise<{ active: number; rowsGone: PluginLoadFailure[] } | undefined>;
}

// Ready is only published once the snapshot is indexed (common.md, The status bar, story 1),
// so conflicts are computed.
async function settleReconciled({ progress, failures }: Heard, deps: ReconciledDeps): Promise<void> {
  deps.registerRepositories();
  const landed = await deps.applyReconciled(failures, progress.total);
  // A hand-off a newer step superseded only adds what it heard, as a refusal does.
  if (landed === undefined) deps.tellHeard(failures);
  else {
    deps.tellLanded(failures, landed.rowsGone);
    deps.statusBar.ready(landed.active);
  }
}

// plugins.md, States 3: the tree's own wording for a row not yet held while mEdit is unreachable.
const UNREACHABLE_REASON = {
  disconnected: 'mEdit is disconnected.',
  stopped: 'mEdit is stopped.',
};

interface IndexStatusDeps {
  client: Pick<MEditClient, 'recordIndexProgress' | 'getPluginsIndexing' | 'onDidChange' | 'onDidChangeRecordIndexProgress' | 'onStatusChanged'>;
  facts: Pick<PluginFactsFeed, 'indexed' | 'refused' | 'reconciled' | 'unreachable' | 'refresh'>;
  progress: PluginsViewProgress;
  statusBar: Pick<StatusBar, 'ready' | 'showMEditState'>;
  registerRepositories: () => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  reporter: Pick<Reporter, 'report' | 'shownOnSurface'>;
}

// plugins.md, States 2–4 and 6: the record index status the stream carries drives the Plugins view,
// whoever started the reconcile. mEdit going away, or a stream reopening onto another process,
// starts its versions over.
export type FollowedNarrator = ReconcileNarrator & { hearNow(): Promise<void> };

export function followIndexStatus(deps: IndexStatusDeps): { narrator: FollowedNarrator } & vscode.Disposable {
  const { client, facts, progress, statusBar, registerRepositories, log, reporter } = deps;
  const tellOnce = tellingOnSurface(reporter, 'error');
  let heardFailures = new Map<string, PluginLoadFailure>();
  const heardOf = (failures: readonly PluginLoadFailure[]) => failures.map((f) => [pluginAddressKey(f), f] as const);
  const tellStanding = (rowsGone: readonly PluginLoadFailure[] = []): void => {
    const gone = new Set(rowsGone.map(pluginAddressKey));
    tellOnce([...heardFailures].map(([key, f]) => (gone.has(key)
      ? { key, message: `The records of ${quotedPluginName(f)} do not show: its read failed.`, why: f.reason, notify: true }
      : { key, message: `Failed to read ${quotedPluginName(f)}.`, why: f.reason })));
  };
  const tellLanded = (failures: readonly PluginLoadFailure[], rowsGone: readonly PluginLoadFailure[]): void => {
    heardFailures = new Map(heardOf(failures));
    tellStanding(rowsGone);
  };
  // A refusal hears only the plugins its reconcile reached.
  const tellHeard = (failures: readonly PluginLoadFailure[]): void => {
    heardFailures = new Map([...heardFailures, ...heardOf(failures)]);
    tellStanding();
  };
  const narrator = createReconcileNarrator({
    showProgress: (until) => void progress.while(() => until),
    applyIndexed: (indexedPlugins, failures) => {
      facts.indexed(indexedPlugins, failures);
      statusBar.showMEditState();
    },
    applyRefused: (refusal, failures) => {
      tellHeard(failures);
      facts.refused(refusal);
      statusBar.showMEditState();
    },
    settle: (heard) => settleReconciled(heard, {
      tellLanded, tellHeard, statusBar, registerRepositories,
      applyReconciled: (failures, totalPlugins) => applyReconciled(deps, failures, totalPlugins),
    }),
    log: (m) => log('error', `[loadOrder] ${m}`),
  });
  let reads = 0;
  let heard = false;
  const hearNow = async (): Promise<void> => {
    const read = ++reads;
    const current = client.recordIndexProgress;
    if (current === undefined) {
      if (heard) {
        narrator.detached();
        statusBar.showMEditState();
      }
      heard = false;
      return;
    }
    const indexing = await client.getPluginsIndexing();
    if (read !== reads) return;
    if (isReadFailed(indexing)) {
      if (current.refusal === undefined) return;
      heard = true;
      narrator.hear({ progress: current, indexed: [], failures: [] });
      return;
    }
    heard = true;
    narrator.hear({
      progress: current, failures: loadFailuresOf(indexing),
      indexed: indexing.filter(({ state }) => state === 'Indexed').map(({ name, origin }) => ({ name, origin })),
    });
  };
  const hearCurrent = (): void => { void hearNow(); };
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
  return { narrator: { ...narrator, hearNow }, dispose: () => { for (const unsubscribe of unsubscribes) unsubscribe(); } };
}

async function applyReconciled(
  { facts, log }: IndexStatusDeps,
  failures: readonly PluginLoadFailure[],
  // Carried in only to be logged next to what reached the tree. Deliberately not the snapshot's
  // plugin count: that omits the implicit masters the backend prepends, so every healthy
  // reconcile would read as short.
  totalPlugins: number,
): Promise<{ active: number; rowsGone: PluginLoadFailure[] } | undefined> {
  const counted = await facts.reconciled(failures);
  // Superseded by a newer step, which shows its own state, or a failed read the feed reported.
  if (counted === undefined) return undefined;
  const { held, active, rowsGone } = counted;
  // Do not remove as logging noise: `held + failures.length` landing close to
  // `totalPlugins` is what tells a stuck-tail reconcile here from one broken upstream.
  log('info', `[loadOrder] applying reconciled load order to tree: ${held} in the load order, ${failures.length} failed, of ${totalPlugins} plugins`);
  return { active, rowsGone };
}
