import { describe, it, expect, vi, onTestFinished } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { asViewCall, RefusedWrite, runWritingGesture, surfaceRefusedWrites } from '../writingGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { Refusal } from '../refusal';

function instanceThatReads() {
  return {
    refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); },
  };
}

describe('a gesture that writes, inside its view\'s progress bar', () => {
  it('runs the command once and then one refresh, inside the view\'s progress bar', async () => {
    steps.length = 0;

    await runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => { steps.push('command'); return Promise.resolve(); });

    expect(steps).toEqual(['progress opens on modbench.thing', 'command', 'refresh', 'progress closes']);
  });

  it('holds the progress bar until the refresh lands', async () => {
    steps.length = 0;
    let lands!: () => void;
    const instance = { refresh: () => new Promise<undefined>((r) => { lands = () => r(undefined); }) };

    const running = runWritingGesture('modbench.write', 'modbench.thing', instance, () => Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on modbench.thing']);

    lands();
    await running;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('shows the disk after a command that throws, and lets the failure through', async () => {
    steps.length = 0;

    await expect(runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => Promise.reject(new Error('half written'))))
      .rejects.toThrow('half written');

    expect(steps).toEqual(['progress opens on modbench.thing', 'refresh', 'progress closes']);
  });

  it('answers what the command answered', async () => {
    expect(await runWritingGesture('modbench.write', 'modbench.thing', instanceThatReads(), () => Promise.resolve('landed'))).toBe('landed');
  });

  describe('while another write is in flight', () => {
    function heldWrite(name: string) {
      let ends!: () => void;
      const running = runWritingGesture(name, 'modbench.thing', instanceThatReads(), () => new Promise<void>((r) => { ends = r; }));
      const end = async () => { ends(); await running; };
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
      const running = runWritingGesture('modbench.mod.build', 'modbench.thing', refreshing, () => Promise.resolve());
      onTestFinished(async () => { lands(); await running; });
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(asked('modbench.mod.rename')).rejects.toThrow(/modbench\.mod\.build/);
    });
  });
});
