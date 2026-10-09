import { describe, it, expect } from 'vitest';
import type { PutLoadOrderResult } from '../../instanceCommands/loadOrder';
import { reportSyncFailures } from '../../drivingLib/syncFailureReport';
import { createReconcileNarrator } from '../reconcileNarrator';
import { editingView } from '../editingView';
import { recordingReporter } from '../../test/surfacingDoubles';

type Sent = Extract<PutLoadOrderResult, { sent: true }>;
type Outcome = Sent['outcome'];

const STATUS = {
  totalPlugins: 1, activePlugins: 1, version: 7, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const SNAPSHOT: Sent['snapshot'] = {
  plugins: [], active: [], loadedWithNoLine: [], gameDirectory: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4',
};

const sent = (outcome: Outcome): PutLoadOrderResult => ({ sent: true, snapshot: SNAPSHOT, outcome });

const refused = (refusal: string): PutLoadOrderResult => ({ sent: false, refusal });

function wired() {
  const handed: unknown[] = [];
  const said: string[] = [];
  const putReports: string[] = [];
  const entryReports: string[] = [];
  const exitReports: string[] = [];
  const launchReports: [string, string][] = [];
  const logged: { info: string[]; error: string[] } = { info: [], error: [] };
  const revealed = { count: 0 };
  const narrator = createReconcileNarrator({
    showProgress: () => undefined, applyIndexed: () => undefined, applyRefused: () => undefined,
    settle: (status) => new Promise((resolve) => { setTimeout(() => { handed.push(status); resolve(); }, 0); }), log: () => undefined,
  });
  const progress = { while: (work: () => Promise<void>) => work(), say: (message: string) => { said.push(message); } };
  const log = { info: (message: string) => { logged.info.push(message); }, error: (message: string) => { logged.error.push(message); } };
  const lines: string[] = [];
  const loadOrderPut = reportSyncFailures('put load order', 'The load order is not sent', (line) => lines.push(line));
  const view = editingView({
    narrator, progress, log, loadOrderPut,
    reporterFor: (tag) => ({
      ...recordingReporter(),
      report: (_severity, message, reason) => {
        if (tag === 'loadOrder') putReports.push(message);
        if (tag === 'enterEditing') entryReports.push(message);
        if (tag === 'mEditExit') exitReports.push(message);
        if (tag === 'launch') launchReports.push([message, reason ?? '']);
      },
    }),
    revealLog: () => { revealed.count++; },
  });
  return { view, handed, said, putReports, entryReports, exitReports, launchReports, logged, revealed, loadOrderPut, lines };
}

describe('the entry shown', () => {
  it('runs under the progress, with the log revealed and the launch said', async () => {
    const { view, said, revealed } = wired();
    const ran: string[] = [];

    await view.around(() => { ran.push(`after ${said.join()} and ${revealed.count} reveal`); return Promise.resolve(); });

    expect(ran).toEqual(['after Starting backend… and 1 reveal']);
  });

  it('tells a backend that did not come up as mEdit stopped, and that reloading the window starts it again', async () => {
    const { view, entryReports, exitReports, putReports } = wired();

    await view.tell({ kind: 'backendFailed' });

    expect(entryReports).toEqual(['mEdit stopped. Reload the window to start it again.']);
    expect([...exitReports, ...putReports]).toEqual([]);
  });

  it('tells an exit as mEdit stopped under its own report, not the entry\'s', async () => {
    const { view, entryReports, exitReports } = wired();

    await view.tell({ kind: 'exited' });

    expect(exitReports).toEqual(['mEdit stopped. Reload the window to start it again.']);
    expect(entryReports).toEqual([]);
  });

  it('tells a launch that threw as mEdit stopped, with its reason', async () => {
    const { view, launchReports, entryReports, putReports } = wired();

    await view.tell({ kind: 'launchFailed', reason: 'no port' });

    expect(launchReports).toEqual([['mEdit stopped. Reload the window to start it again.', 'no port']]);
    expect([...entryReports, ...putReports]).toEqual([]);
  });
});

describe('a load order the loader refused, shown', () => {
  it("says the refusal in the Plugins view's message line and once in the Output, however many values repeat it", async () => {
    const { view, loadOrderPut, lines } = wired();

    await view.tell({ kind: 'put', put: refused('a.esp is provided by the mod ModA, which has no mod folder') });
    await view.tell({ kind: 'put', put: refused('a.esp is provided by the mod ModA, which has no mod folder') });

    expect(loadOrderPut.message()).toBe('The load order is not sent: a.esp is provided by the mod ModA, which has no mod folder.');
    expect(lines).toEqual(['put load order failed: a.esp is provided by the mod ModA, which has no mod folder']);
  });

  it('clears the message line once a snapshot is sent', async () => {
    const { view, loadOrderPut } = wired();
    await view.tell({ kind: 'put', put: refused('a.esp has no mod folder') });

    await view.tell({ kind: 'put', put: sent({ outcome: 'abandoned' }) });

    expect(loadOrderPut.message()).toBeUndefined();
  });

  it('leaves the line alone for a game folder not found, which the views already tell', async () => {
    const { view, loadOrderPut } = wired();
    await view.tell({ kind: 'put', put: refused('a.esp has no mod folder') });

    await view.tell({ kind: 'put', put: { sent: false } });

    expect(loadOrderPut.message()).toBeDefined();
  });
});

describe("a put's own outcome shown", () => {
  it("reports a failed send's message verbatim, as the put's", async () => {
    const { view, putReports, entryReports, handed } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }) });

    expect(putReports).toEqual(['Failed to send the load order — bad dir']);
    expect([entryReports, handed]).toEqual([[], []]);
  });

  it('says nothing for an abandoned send, which owns no view', async () => {
    const { view, putReports, handed } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'abandoned' }) });

    expect([putReports, handed]).toEqual([[], []]);
  });

  it("hands an applied send's status to the views and is done once they hold it", async () => {
    const { view, putReports, handed } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'applied', status: STATUS }) });

    expect(handed).toEqual([STATUS]);
    expect(putReports).toEqual([]);
  });

  it('shows nothing when no snapshot was sent', async () => {
    const { view, putReports, handed, logged } = wired();

    await view.tell({ kind: 'put', put: { sent: false } });

    expect([putReports, handed, logged.info]).toEqual([[], [], []]);
  });
});
