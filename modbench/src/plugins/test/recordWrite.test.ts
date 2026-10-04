import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { recordWriteOver } from '../recordWrite';

const instanceThatReads = () => ({ refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); } });
const noPut = { latest: () => Promise.resolve(undefined) };

describe('a record write', () => {
  it('holds the Plugins view\'s progress until the index reaches the newest load order the read put', async () => {
    steps.length = 0;
    let reached!: () => void;
    const sender = { latest: () => new Promise<undefined>((resolve) => { reached = () => resolve(undefined); }) };

    const writing = recordWriteOver(instanceThatReads(), sender)(() => { steps.push('write'); return Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on modbench.pluginListTree', 'write', 'refresh']);

    reached();
    await writing;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('ends when the read lands when no put follows it', async () => {
    steps.length = 0;

    await recordWriteOver(instanceThatReads(), noPut)(() => Promise.resolve());

    expect(steps).toEqual(['progress opens on modbench.pluginListTree', 'refresh', 'progress closes']);
  });

  it('runs under the bar of the view it was invoked from', async () => {
    steps.length = 0;

    await recordWriteOver(instanceThatReads(), noPut)(() => Promise.resolve(), 'modbench.referencedByTree');

    expect(steps[0]).toBe('progress opens on modbench.referencedByTree');
  });
});
