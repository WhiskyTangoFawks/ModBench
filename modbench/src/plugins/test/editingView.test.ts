import { describe, it, expect, vi } from 'vitest';
import type { PutLoadOrderResult } from '../../instanceCommands/loadOrder';
import { reportSyncFailures } from '../../drivingLib/syncFailureReport';
import { editingView } from '../editingView';

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
  const narrator = { hear: vi.fn(), settled: vi.fn(() => Promise.resolve()) };
  const progress = { while: vi.fn((work: () => Promise<void>) => work()), say: vi.fn() };
  const reportPut = vi.fn();
  const reportEntry = vi.fn();
  const log = { info: vi.fn(), error: vi.fn() };
  const revealLog = vi.fn();
  const lines: string[] = [];
  const loadOrderPut = reportSyncFailures('put load order', 'The load order is not sent', (line) => lines.push(line));
  const view = editingView({ narrator, progress, reportPut, reportEntry, log, revealLog, loadOrderPut });
  return { view, narrator, progress, reportPut, reportEntry, log, revealLog, loadOrderPut, lines };
}

describe('the entry shown', () => {
  it('runs under the progress, with the log revealed and the launch said', async () => {
    const { view, progress, revealLog } = wired();
    const entry = vi.fn(() => Promise.resolve());

    await view.around(entry);

    expect(progress.say).toHaveBeenCalledWith('Starting backend…');
    expect(revealLog).toHaveBeenCalledOnce();
    expect(entry).toHaveBeenCalledOnce();
  });

  it('tells a backend that did not come up, as an error of the entry', async () => {
    const { view, reportEntry, reportPut } = wired();

    await view.tell({ kind: 'backendFailed' });

    expect(reportEntry).toHaveBeenCalledWith(expect.stringContaining('Backend failed to start'));
    expect(reportPut).not.toHaveBeenCalled();
  });

  it('only logs an abandoned launch, which owns no view', async () => {
    const { view, log, reportEntry, reportPut } = wired();

    await view.tell({ kind: 'abandoned' });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('abandoned'));
    expect([reportEntry, reportPut].flatMap((f) => f.mock.calls)).toEqual([]);
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
    const { view, reportPut, reportEntry, narrator } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }) });

    expect(reportPut).toHaveBeenCalledWith('Failed to send the load order — bad dir');
    expect(reportEntry).not.toHaveBeenCalled();
    expect(narrator.hear).not.toHaveBeenCalled();
  });

  it('says nothing for an abandoned send, which owns no view', async () => {
    const { view, reportPut, narrator } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'abandoned' }) });

    expect(reportPut).not.toHaveBeenCalled();
    expect(narrator.hear).not.toHaveBeenCalled();
  });

  it("hands an applied send's status to the narrator and waits for its version to settle", async () => {
    const { view, reportPut, narrator } = wired();

    await view.tell({ kind: 'put', put: sent({ outcome: 'applied', status: STATUS }) });

    expect(narrator.hear).toHaveBeenCalledWith(STATUS);
    expect(narrator.settled).toHaveBeenCalledWith(7);
    expect(reportPut).not.toHaveBeenCalled();
  });

  it('shows nothing when no snapshot was sent', async () => {
    const { view, reportPut, narrator, log } = wired();

    await view.tell({ kind: 'put', put: { sent: false } });

    expect(narrator.hear).not.toHaveBeenCalled();
    expect(reportPut).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs a put that threw, since no caller is left to hear it', async () => {
    const { view, log } = wired();

    await view.tell({ kind: 'putThrew', message: 'boom' });

    expect(log.error).toHaveBeenCalledWith('[loadOrder] handing mEdit the load order threw: boom');
  });
});
