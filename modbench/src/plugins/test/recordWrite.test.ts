import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { InMemoryMEditClient } from '../../client';
import { recordWriteOver } from '../recordWrite';

const instanceThatReads = () => ({ refresh: () => { steps.push('refresh'); return Promise.resolve(undefined); } });

describe('a record write', () => {
  it('holds the Plugins view\'s progress until the index reaches the load order the read put', async () => {
    steps.length = 0;
    const client = new InMemoryMEditClient();
    let reached!: () => void;
    client.setCommandHandler('putLoadOrder', () => new Promise((resolve) => {
      reached = () => resolve({ outcome: 'abandoned' });
    }));
    const instance = {
      refresh: () => {
        steps.push('refresh');
        void client.putLoadOrder([], [], [], '/game/Data', '/instance', 'Fallout4');
        return Promise.resolve(undefined);
      },
    };

    const writing = recordWriteOver(instance, client)(() => { steps.push('write'); return Promise.resolve(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['progress opens on modbench.pluginListTree', 'write', 'refresh']);

    reached();
    await writing;
    expect(steps.at(-1)).toBe('progress closes');
  });

  it('ends when the read lands when no put follows it', async () => {
    steps.length = 0;

    await recordWriteOver(instanceThatReads(), new InMemoryMEditClient())(() => Promise.resolve());

    expect(steps).toEqual(['progress opens on modbench.pluginListTree', 'refresh', 'progress closes']);
  });
});
