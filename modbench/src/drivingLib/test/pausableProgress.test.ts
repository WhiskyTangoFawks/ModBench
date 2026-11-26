import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  const { EventEmitter } = await import('../../test/vscodeMock');
  return { window: { withProgress: recordedWithProgress }, EventEmitter };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { pausableProgress } from '../pausableProgress';
import { runWritingGesture } from '../writingGesture';
import { RedrawEmitter } from '../heldRedraw';
import { settled } from '../../test/eventually';

beforeEach(() => {
  steps.length = 0;
});

describe('a view\'s progress that pauses while a person is asked', () => {
  it('shows progress while working, none while waiting, and again when working resumes', async () => {
    const progress = pausableProgress('modbench.thing');

    progress.working();
    progress.working();
    progress.waiting();
    await settled(() => { expect(steps).toEqual(['progress opens on modbench.thing', 'progress closes']); });
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

describe('a view\'s redraw while its gesture waits on a person (common.md, A gesture that writes, story 1; A view, story 2)', () => {
  it('holds while working, draws what it held and follows the disk while waiting, and holds again once working resumes', async () => {
    const progress = pausableProgress('modbench.thing');
    const emitter = new RedrawEmitter<string | undefined>('modbench.thing');
    const fired: (string | undefined)[] = [];
    emitter.event((row) => { fired.push(row); });

    progress.working();
    emitter.fire('held while working');
    const whileWorking = [...fired];
    progress.waiting();
    emitter.fire('changed on disk while waiting');
    const whileWaiting = [...fired];
    progress.working();
    emitter.fire('held again');
    const resumed = [...fired];
    await progress.done();

    expect({ whileWorking, whileWaiting, resumed, done: fired }).toEqual({
      whileWorking: [],
      whileWaiting: ['held while working', 'changed on disk while waiting'],
      resumed: ['held while working', 'changed on disk while waiting'],
      done: ['held while working', 'changed on disk while waiting', 'held again'],
    });
  });
});

describe('a writing gesture that waits on a person', () => {
  it('closes its progress while it waits, and shows it again for the rest of the command', async () => {
    const instance = { refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); } };

    await runWritingGesture('modbench.write', 'modbench.thing', instance, async (progress) => {
      steps.push('extracting');
      progress.waiting();
      await settled(() => { expect(steps.at(-1)).toBe('progress closes'); });
      steps.push('person answered');
      progress.working();
      steps.push('landing');
    });

    expect(steps).toEqual([
      'progress opens on modbench.thing', 'extracting', 'progress closes', 'person answered', 'progress opens on modbench.thing', 'landing',
      'progress closes',
    ]);
  });
});
