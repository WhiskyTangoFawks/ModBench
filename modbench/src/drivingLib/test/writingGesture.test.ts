import { describe, it, expect, vi, onTestFinished } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { asViewCall, handingOneChange, holdingTheWrite, whenNoChangeIsRunning, RefusedWrite, runUnderProgress, runWritingGesture, surfaceManagerRunning, type ManagerState, surfaceReadModel, surfaceRefusedWrites } from '../writingGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { Refusal } from '../refusal';
import { ambientWrites } from '../../instanceLoader/ambientWrites';
import { toldAfter } from '../../repositoriesLib/writesTold';

const unnamed = (): Promise<void> => { ambientWrites.leaveUnnamed(); return Promise.resolve(); };

function instanceThatReads() {
  return {
    refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); },
  };
}

describe('a gesture that writes, inside its view\'s progress bar', () => {
  it('runs the command once and then, when its writes were left unnamed, one refresh, inside the view\'s progress bar', async () => {
    steps.length = 0;

    await runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => { steps.push('command'); return unnamed(); });

    expect(steps).toEqual(['progress opens on modbench.thing', 'command', 'refresh', 'progress closes']);
  });

  it('holds the progress bar until the refresh lands', async () => {
    steps.length = 0;
    let lands!: () => void;
    const instance = { refresh: () => new Promise<undefined>((r) => { lands = () => r(undefined); }) };

    const running = runWritingGesture('modbench.write', 'modbench.thing', instance, unnamed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on modbench.thing']);

    lands();
    await running;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('shows the disk after a command that throws having left its writes unnamed, and lets the failure through', async () => {
    steps.length = 0;

    await expect(runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => { ambientWrites.leaveUnnamed(); return Promise.reject(new Error('half written')); }))
      .rejects.toThrow('half written');

    expect(steps).toEqual(['progress opens on modbench.thing', 'refresh', 'progress closes']);
  });

  it.each([
    ['refreshes at the files a write the command made named, though the command named none itself', () => { ambientWrites.name(['/mods/A/meta.ini']); }, [[['/mods/A/meta.ini']]]],
    ['ends when its writes return, refreshing nothing, when every write told the Instance loader', () => undefined, []],
    ['checks the whole disk when the command left its writes unnamed', () => { ambientWrites.leaveUnnamed(); }, [[]]],
  ])('%s', async (_name, write, refreshes) => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await runWritingGesture('modbench.write', 'modbench.thing', { refresh }, () => { write(); return Promise.resolve(); });

    expect(refresh.mock.calls).toEqual(refreshes);
  });

  describe('with the mod manager\'s state surfaced', () => {
    const says = (state: ManagerState) => (state.kind === 'running' ? 'MO2 is running.' : state.kind === 'unknown' ? 'Cannot tell whether MO2 is running.' : undefined);

    function surfacedManager(running: () => Promise<ManagerState>) {
      const reporter = recordingReporter();
      const surface = surfaceManagerRunning({ reporter, running, message: says });
      onTestFinished(() => { surface.dispose(); });
      return reporter;
    }

    const running = () => Promise.resolve<ManagerState>({ kind: 'running' });
    const unknown = () => Promise.resolve<ManagerState>({ kind: 'unknown', reason: 'x' });
    const notRunning = () => Promise.resolve<ManagerState>({ kind: 'notRunning' });
    const wrote = () => holdingTheWrite('modbench.write', () => Promise.resolve('landed'));
    const noticed = (reporter: ReturnType<typeof recordingReporter>) => reporter.reports.map((report) => report.message);

    it('warns once a write held through holdingTheWrite has landed, when the manager is running at that moment', async () => {
      const reporter = surfacedManager(running);

      await wrote();

      expect(reporter.reports).toEqual([{ severity: 'warning', message: 'MO2 is running.', detail: undefined }]);
    });

    it('says nothing for a gesture that holds no write', async () => {
      const reporter = surfacedManager(running);

      await runUnderProgress('modbench.thing', instanceThatReads(), unnamed);

      expect(reporter.reports).toEqual([]);
    });

    it('says nothing when the manager is not running', async () => {
      const reporter = surfacedManager(notRunning);

      await wrote();

      expect(reporter.reports).toEqual([]);
    });

    it('says nothing when the gesture was refused and wrote nothing', async () => {
      const reporter = surfacedManager(running);

      await holdingTheWrite('modbench.write', () => Promise.resolve({ applied: false, refusal: 'no' }));

      expect(reporter.reports).toEqual([]);
    });

    it('starts the command without waiting on the ask', () => {
      surfacedManager(() => new Promise<ManagerState>(() => undefined));
      const commandRan = vi.fn();

      void holdingTheWrite('modbench.write', () => { commandRan(); return Promise.resolve(); });

      expect(commandRan).toHaveBeenCalled();
    });

    it('holds the write against another until the command is done, whatever the ask is doing', async () => {
      surfacedManager(() => new Promise<ManagerState>(() => undefined));
      let ends!: () => void;
      void holdingTheWrite('modbench.write', () => new Promise<void>((r) => { ends = r; }));

      await expect(holdingTheWrite('modbench.other', () => Promise.resolve())).rejects.toBeInstanceOf(RefusedWrite);
      ends();
    });

    it('is a notification whatever the result is, and leaves the result as it was', async () => {
      const reporter = surfacedManager(running);

      const answer = await holdingTheWrite('modbench.write', () => Promise.resolve({ applied: true, partial: [] }));

      expect({ answer, reports: reporter.reports }).toEqual({
        answer: { applied: true, partial: [] },
        reports: [{ severity: 'warning', message: 'MO2 is running.', detail: undefined }],
      });
    });

    it('warns at every write while the manager is running', async () => {
      const reporter = surfacedManager(running);

      await wrote();
      await wrote();

      expect(noticed(reporter)).toEqual(['MO2 is running.', 'MO2 is running.']);
    });

    it('says it cannot tell only when the answer changes to unknown', async () => {
      let answers = [unknown, unknown, running, unknown];
      const reporter = surfacedManager(() => (answers.shift() ?? unknown)());

      for (let write = 0; write < 4; write++) await wrote();

      expect(noticed(reporter)).toEqual(['Cannot tell whether MO2 is running.', 'MO2 is running.', 'Cannot tell whether MO2 is running.']);
      answers = [];
    });

    it('logs a failed ask once, treats it as unknown, and does not delay the write', async () => {
      const reporter = surfacedManager(() => Promise.reject(new Error('tasklist failed')));

      await wrote();
      await wrote();

      expect({ shown: reporter.shownFailures.length, noticed: noticed(reporter) }).toEqual({
        shown: 1,
        noticed: ['Cannot tell whether the mod manager is running: tasklist failed.'],
      });
    });
  });

  describe('with the other read model surfaced', () => {
    function otherReadModel() {
      let handed = 0;
      let shows!: () => void;
      const surface = surfaceReadModel({
        handed: () => handed,
        taken: () => new Promise<void>((resolve) => { shows = resolve; }),
      });
      onTestFinished(() => { surface.dispose(); });
      return { hand: () => { handed++; }, shows: () => { shows(); } };
    }

    it('holds the view\'s progress until the send its refresh handed has shown', async () => {
      steps.length = 0;
      const other = otherReadModel();
      const instance = { refresh: () => { other.hand(); steps.push('refresh'); return Promise.resolve(undefined); } };

      const running = runWritingGesture('modbench.write', 'modbench.thing', instance, unnamed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(steps).toEqual(['progress opens on modbench.thing', 'refresh']);

      other.shows();
      await running;
      expect(steps.at(-1)).toBe('progress closes');
    });

    it('ends at once when its refresh handed no send, whatever send is outstanding', async () => {
      steps.length = 0;
      const other = otherReadModel();
      other.hand();

      await runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), unnamed);

      expect(steps).toEqual(['progress opens on modbench.thing', 'refresh', 'progress closes']);
    });
  });

  it('answers what the command answered', async () => {
    expect(await runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => Promise.resolve('landed'))).toBe('landed');
  });

  describe('while another write is in flight', () => {
    function heldWrite(name: string) {
      let ends!: () => void;
      let started!: () => void;
      const hasStarted = new Promise<void>((r) => { started = r; });
      const running = runWritingGesture(name, 'modbench.thing', instanceThatReads(), () => new Promise<void>((r) => { ends = r; started(); }));
      const end = async () => { await hasStarted; ends(); await running; };
      onTestFinished(end);
      return { end };
    }

    const asked = (write: string) => runWritingGesture(write, 'modbench.thing', instanceThatReads(), () => Promise.resolve('landed'));

    function surfaced() {
      const reporter = recordingReporter();
      const redraw = vi.fn();
      const surface = surfaceRefusedWrites({
        reporter, redraw, titles: new Map([['modbench.mod.build', 'Build Mod'], ['modbench.mod.rename', 'Rename Mod']]),
      });
      onTestFinished(() => { surface.dispose(); });
      return { reporter, redraw };
    }

    it('is refused, naming the write in flight, and starts nothing', async () => {
      steps.length = 0;
      heldWrite('modbench.mod.build');

      await expect(runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => { steps.push('second command'); return Promise.resolve(); }))
        .rejects.toThrow(/modbench\.mod\.build/);

      expect(steps).not.toContain('second command');
    });

    it('is refused as a Refusal, which an agent reads as the reason', async () => {
      heldWrite('modbench.mod.build');

      await expect(asked('modbench.mod.rename')).rejects.toBeInstanceOf(Refusal);
    });

    it('names both writes by the titles the user saw', async () => {
      surfaced();
      heldWrite('modbench.mod.build');

      await expect(asked('modbench.mod.rename')).rejects.toThrow('Rename Mod did not start: Build Mod is still writing.');
    });

    it('tells a view call once, in a notification and the Output, and draws the view from the held value', async () => {
      const { reporter, redraw } = surfaced();
      heldWrite('modbench.mod.build');

      const answered = await asViewCall(() => asked('modbench.mod.rename'));

      expect({ answered, reports: reporter.reports, redraws: redraw.mock.calls.length, shownOnSurface: reporter.shownFailures }).toEqual({
        answered: undefined,
        reports: [{ severity: 'error', message: 'Rename Mod did not start: Build Mod is still writing.', detail: undefined }],
        redraws: 1,
        shownOnSurface: [],
      });
    });

    it('lets a failure that is no refusal through a view call', async () => {
      await expect(asViewCall(() => Promise.reject(new Error('half written')))).rejects.toThrow('half written');
    });

    it('is a RefusedWrite, which a caller that catches failures lets through', async () => {
      heldWrite('modbench.mod.build');

      await expect(asked('modbench.mod.rename')).rejects.toBeInstanceOf(RefusedWrite);
    });

    it('runs once the write in flight has refreshed', async () => {
      await heldWrite('modbench.mod.build').end();

      expect(await asked('modbench.mod.rename')).toBe('landed');
    });

    it('runs once the write in flight has failed', async () => {
      await expect(runWritingGesture('modbench.mod.build', 'modbench.thing', instanceThatReads(), () => Promise.reject(new Error('half written')))).rejects.toThrow();

      expect(await asked('modbench.mod.rename')).toBe('landed');
    });

    it('stays held while the refresh that shows the write is running', async () => {
      let lands!: () => void;
      const refreshing = { refresh: () => new Promise<undefined>((r) => { lands = () => r(undefined); }) };
      const running = runWritingGesture('modbench.mod.build', 'modbench.thing', refreshing, unnamed);
      onTestFinished(async () => { lands(); await running; });
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(asked('modbench.mod.rename')).rejects.toThrow(/modbench\.mod\.build/);
    });
  });
});

describe('handingOneChange', () => {
  const noFile = '/mods/A/meta.ini';
  const told = '/mods/A/a.esp';

  it('tells the files its writes told and the files they named in one read, however many writes there were', async () => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await handingOneChange({ refresh }, async () => {
      await toldAfter([told], () => Promise.resolve());
      ambientWrites.name([noFile]);
    });

    expect(refresh.mock.calls).toEqual([[[told, noFile]]]);
  });

  it('checks the disk in that one read when a write left its files unnamed', async () => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await handingOneChange({ refresh }, async () => {
      await toldAfter([told], () => Promise.resolve());
      ambientWrites.leaveUnnamed();
    });

    expect(refresh.mock.calls).toEqual([[]]);
  });

  it('reads nothing when its writes wrote nothing', async () => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await handingOneChange({ refresh }, () => Promise.resolve());

    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads once, when the outer change ends, for a change inside another', async () => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await handingOneChange({ refresh }, async () => {
      await handingOneChange({ refresh }, () => toldAfter([told], () => Promise.resolve()));
      expect(refresh).not.toHaveBeenCalled();
    });

    expect(refresh.mock.calls).toEqual([[[told]]]);
  });

  it('reads what a failed change wrote, and lets the failure through', async () => {
    const refresh = vi.fn((_named?: readonly string[]) => Promise.resolve());

    await expect(handingOneChange({ refresh }, async () => {
      await toldAfter([told], () => Promise.resolve());
      throw new Error('half written');
    })).rejects.toThrow('half written');

    expect(refresh.mock.calls).toEqual([[[told]]]);
  });
});

describe('whenNoChangeIsRunning', () => {
  const idle = { refresh: () => Promise.resolve() };

  it('runs its task at once when no change is running', async () => {
    const task = vi.fn(() => Promise.resolve());

    await whenNoChangeIsRunning(task).run();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs its task once after the change ends, however often it was asked, and does not hold the change', async () => {
    const task = vi.fn(() => Promise.resolve());
    const gated = whenNoChangeIsRunning(task);

    await handingOneChange(idle, async () => {
      await gated.run();
      await gated.run();
      expect(task).not.toHaveBeenCalled();
    });

    await vi.waitFor(() => { expect(task).toHaveBeenCalledTimes(1); });
  });

  it('runs its task after the outer change of two nested, not the inner', async () => {
    const task = vi.fn(() => Promise.resolve());
    const gated = whenNoChangeIsRunning(task);

    await handingOneChange(idle, async () => {
      await handingOneChange(idle, () => gated.run());
      expect(task).not.toHaveBeenCalled();
    });

    await vi.waitFor(() => { expect(task).toHaveBeenCalledTimes(1); });
  });

  it('runs its task after a change that threw', async () => {
    const task = vi.fn(() => Promise.resolve());
    const gated = whenNoChangeIsRunning(task);

    await expect(handingOneChange(idle, async () => { await gated.run(); throw new Error('half written'); })).rejects.toThrow('half written');

    await vi.waitFor(() => { expect(task).toHaveBeenCalledTimes(1); });
  });

  it('never runs a task disposed while it waited', async () => {
    const task = vi.fn(() => Promise.resolve());
    const other = vi.fn(() => Promise.resolve());
    const gated = whenNoChangeIsRunning(task);
    const stays = whenNoChangeIsRunning(other);

    await handingOneChange(idle, async () => {
      await gated.run();
      await stays.run();
      gated.dispose();
    });

    await vi.waitFor(() => { expect(other).toHaveBeenCalledTimes(1); });
    expect(task).not.toHaveBeenCalled();
  });

  it('reports a task that fails and still runs the others', async () => {
    const reporter = recordingReporter();
    const surface = surfaceRefusedWrites({ reporter, titles: new Map(), redraw: () => undefined });
    onTestFinished(() => { surface.dispose(); });
    const other = vi.fn(() => Promise.resolve());
    const fails = whenNoChangeIsRunning(() => Promise.reject(new Error('disk full')));
    const stays = whenNoChangeIsRunning(other);

    await handingOneChange(idle, async () => {
      await fails.run();
      await stays.run();
    });

    await vi.waitFor(() => { expect(other).toHaveBeenCalledTimes(1); });
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'disk full', detail: undefined }]);
  });
});
