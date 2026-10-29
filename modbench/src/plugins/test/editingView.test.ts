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
  plugins: [], active: [], loadedWithNoLine: [], archives: [], stringsFiles: [], places: [],
  dataFolder: '/game/Data', instanceRoot: '/instance', gameRelease: 'Fallout4', stringsLanguage: 'English',
};

const sent = (outcome: Outcome): PutLoadOrderResult => ({ sent: true, snapshot: SNAPSHOT, outcome });

const refused = (refusal: string): PutLoadOrderResult => ({ sent: false, refusal });

function wired() {
  const handed: unknown[] = [];
  const said: string[] = [];
  const putReports: string[] = [];
  const logged: string[] = [];
  const revealed = { count: 0 };
  const narrator = createReconcileNarrator({
    showProgress: () => undefined, applyIndexed: () => undefined, applyRefused: () => undefined,
    settle: (status) => new Promise((resolve) => { setTimeout(() => { handed.push(status); resolve(); }, 0); }), log: () => undefined,
  });
  const progress = { while: (work: () => Promise<void>) => work(), say: (message: string) => { said.push(message); } };
  const log = { info: (message: string) => { logged.push(message); } };
  const lines: string[] = [];
  const loadOrderPut = reportSyncFailures('put load order', 'The load order is not sent', (line) => lines.push(line));
  const view = editingView({
    narrator, progress, log, loadOrderPut,
    reporterFor: (tag) => ({
      ...recordingReporter(),
      report: (_severity, message) => { putReports.push(`${tag}: ${message}`); },
    }),
    revealLog: () => { revealed.count++; },
  });
  return { view, handed, said, putReports, logged, revealed, loadOrderPut, lines };
}

describe('the entry shown', () => {
  it('runs under the progress, with the log revealed and the launch said', async () => {
    const { view, said, revealed } = wired();
    const ran: string[] = [];

    await view.around(() => { ran.push(`after ${said.join()} and ${revealed.count} reveal`); return Promise.resolve(); });

    expect(ran).toEqual(['after Starting backend… and 1 reveal']);
  });
});

describe('a load order the loader refused, shown', () => {
  it("says the refusal in the Plugins view's message line and in the Output", async () => {
    const { view, loadOrderPut, lines } = wired();

    await view.onPut(refused('a.esp is provided by the mod ModA, which has no mod folder'));

    expect(loadOrderPut.message()).toBe('The load order is not sent: a.esp is provided by the mod ModA, which has no mod folder.');
    expect(lines).toEqual(['put load order failed: a.esp is provided by the mod ModA, which has no mod folder']);
  });

  it('clears the message line once a snapshot is sent', async () => {
    const { view, loadOrderPut } = wired();
    await view.onPut(refused('a.esp has no mod folder'));

    await view.onPut(sent({ outcome: 'abandoned' }));

    expect(loadOrderPut.message()).toBeUndefined();
  });

  it('leaves the line alone for a game folder not found, which the views already tell', async () => {
    const { view, loadOrderPut } = wired();
    await view.onPut(refused('a.esp has no mod folder'));

    await view.onPut({ sent: false });

    expect(loadOrderPut.message()).toBe('The load order is not sent: a.esp has no mod folder.');
  });
});

describe("a put's own outcome shown", () => {
  it("reports a failed send's message verbatim, as the put's", async () => {
    const { view, putReports, handed } = wired();

    await view.onPut(sent({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }));

    expect([putReports, handed]).toEqual([['loadOrder: Failed to send the load order — bad dir'], []]);
  });

  it('says nothing for an abandoned send, which owns no view', async () => {
    const { view, putReports, handed } = wired();

    await view.onPut(sent({ outcome: 'abandoned' }));

    expect([putReports, handed]).toEqual([[], []]);
  });

  it("hands an applied send's status to the views and is done once they hold it", async () => {
    const { view, putReports, handed } = wired();

    await view.onPut(sent({ outcome: 'applied', status: STATUS }));

    expect(handed).toEqual([STATUS]);
    expect(putReports).toEqual([]);
  });

  it('shows nothing when no snapshot was sent', async () => {
    const { view, putReports, handed, logged } = wired();

    await view.onPut({ sent: false });

    expect([putReports, handed, logged]).toEqual([[], [], []]);
  });
});
