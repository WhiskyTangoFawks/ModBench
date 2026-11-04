import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { runWritingGesture, surfaceRefusedWrites } from '../writingGesture';
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
      return { running, ends: () => ends() };
    }

    it('is refused, naming the write in flight, and starts nothing', async () => {
      steps.length = 0;
      const held = heldWrite('modbench.mod.build');

      await expect(runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => { steps.push('second command'); return Promise.resolve(); }))
        .rejects.toThrow(/modbench\.mod\.build/);

      expect(steps).not.toContain('second command');
      held.ends();
      await held.running;
    });

    it('is refused as a Refusal, which an agent reads as the reason', async () => {
      const held = heldWrite('modbench.mod.build');

      await expect(runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => Promise.resolve()))
        .rejects.toBeInstanceOf(Refusal);

      held.ends();
      await held.running;
    });

    it('is logged on the Output under the titles the user saw, and still refused', async () => {
      const shownOnSurface = vi.fn();
      const surface = surfaceRefusedWrites({
        reporter: { report: vi.fn(), landed: vi.fn(), shownOnSurface, selectionOutcome: vi.fn() },
        titles: new Map([['modbench.mod.build', 'Build Mod'], ['modbench.mod.rename', 'Rename Mod']]),
      });
      const held = heldWrite('modbench.mod.build');

      await expect(runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => Promise.resolve())).rejects.toThrow('Rename Mod did not start: Build Mod is still writing.');

      expect(shownOnSurface).toHaveBeenCalledWith('error', 'Rename Mod did not start: Build Mod is still writing.');
      surface.dispose();
      held.ends();
      await held.running;
    });

    it('runs once the write in flight has refreshed', async () => {
      const held = heldWrite('modbench.mod.build');
      held.ends();
      await held.running;

      expect(await runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => Promise.resolve('landed'))).toBe('landed');
    });

    it('runs once the write in flight has failed', async () => {
      await expect(runWritingGesture('modbench.mod.build', 'modbench.thing', instanceThatReads(), () => Promise.reject(new Error('half written')))).rejects.toThrow();

      expect(await runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => Promise.resolve('landed'))).toBe('landed');
    });

    it('stays held while the refresh that shows the write is running', async () => {
      let lands!: () => void;
      const refreshing = { refresh: () => new Promise<undefined>((r) => { lands = () => r(undefined); }) };
      const running = runWritingGesture('modbench.mod.build', 'modbench.thing', refreshing, () => Promise.resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(runWritingGesture('modbench.mod.rename', 'modbench.thing', instanceThatReads(), () => Promise.resolve())).rejects.toThrow(/modbench\.mod\.build/);

      lands();
      await running;
    });
  });
});
