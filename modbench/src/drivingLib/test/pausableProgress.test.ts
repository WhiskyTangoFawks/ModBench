import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { pausableProgress } from '../pausableProgress';
import { runWritingGesture } from '../writingGesture';

beforeEach(() => {
  steps.length = 0;
});

describe('a view\'s progress that pauses while a person is asked', () => {
  it('shows progress while working, none while waiting, and again when working resumes', async () => {
    const progress = pausableProgress('modbench.thing');

    progress.working();
    progress.working();
    progress.waiting();
    await vi.waitFor(() => { expect(steps).toEqual(['progress opens on modbench.thing', 'progress closes']); });
    progress.working();
    await progress.done();

    expect(steps).toEqual([
      'progress opens on modbench.thing', 'progress closes', 'progress opens on modbench.thing', 'progress closes',
    ]);
  });

  it('shows none when done while waiting', async () => {
    const progress = pausableProgress('modbench.thing');

    progress.working();
    progress.waiting();
    await progress.done();

    expect(steps).toEqual(['progress opens on modbench.thing', 'progress closes']);
  });
});

describe('a writing gesture that waits on a person', () => {
  it('closes its progress while it waits, and shows it again for the refresh', async () => {
    const instance = { refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); } };

    await runWritingGesture('modbench.thing', instance, async (progress) => {
      steps.push('extracting');
      progress.waiting();
      await vi.waitFor(() => { expect(steps.at(-1)).toBe('progress closes'); });
      steps.push('person answered');
      progress.working();
      steps.push('landing');
    });

    expect(steps).toEqual([
      'progress opens on modbench.thing', 'extracting', 'progress closes', 'person answered', 'progress opens on modbench.thing', 'landing',
      'refresh', 'progress closes',
    ]);
  });
});
