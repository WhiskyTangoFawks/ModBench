import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { runWritingGesture } from '../writingGesture';

function instanceThatReads() {
  return {
    refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); },
  };
}

describe('runWritingGesture', () => {
  it('runs the command once and then one refresh, inside the view\'s progress bar', async () => {
    steps.length = 0;

    await runWritingGesture('modbench.thing', instanceThatReads(), () => { steps.push('command'); return Promise.resolve(); });

    expect(steps).toEqual(['progress opens on modbench.thing', 'command', 'refresh', 'progress closes']);
  });

  it('holds the progress bar until the refresh lands', async () => {
    steps.length = 0;
    let lands!: () => void;
    const instance = { refresh: () => new Promise<undefined>((r) => { lands = () => r(undefined); }) };

    const running = runWritingGesture('modbench.thing', instance, () => Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on modbench.thing']);

    lands();
    await running;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('shows the disk after a command that throws, and lets the failure through', async () => {
    steps.length = 0;

    await expect(runWritingGesture('modbench.thing', instanceThatReads(), () => Promise.reject(new Error('half written'))))
      .rejects.toThrow('half written');

    expect(steps).toEqual(['progress opens on modbench.thing', 'refresh', 'progress closes']);
  });
});
