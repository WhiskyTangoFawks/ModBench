import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { recordWriteOver } from '../recordWrite';

const VIEW = 'a.view';
const instanceThatReads = () => ({ refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); } });
const noPut = { latestLoadOrder: () => Promise.resolve(undefined) };

describe('a record write', () => {
  it('holds the view\'s progress until the record index reaches the newest load order the read put', async () => {
    steps.length = 0;
    let reached!: () => void;
    const client = { latestLoadOrder: () => new Promise<undefined>((resolve) => { reached = () => resolve(undefined); }) };

    const writing = recordWriteOver(VIEW, instanceThatReads(), client)(() => { steps.push('write'); return Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on a.view', 'write', 'refresh']);

    reached();
    await writing;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('ends when the read lands when no put follows it', async () => {
    steps.length = 0;

    await recordWriteOver(VIEW, instanceThatReads(), noPut)(() => Promise.resolve());

    expect(steps).toEqual(['progress opens on a.view', 'refresh', 'progress closes']);
  });
});
