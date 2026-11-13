import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { pluginSyncOn } from '../pluginSync';
import { ambientWrites } from '../../instanceLoader/ambientWrites';

const channel = { error: () => undefined, info: () => undefined };

function instanceHeard() {
  let subscriber!: () => Promise<void>;
  const refresh = vi.fn((wrote?: readonly string[]) => { void wrote; return Promise.resolve(); });
  const instance = { refresh, subscribe: (s: () => Promise<void>) => { subscriber = s; return { dispose: () => undefined }; } };
  const hears = () => subscriber();
  return { instance, refresh, hears };
}

describe('plugin sync on the instance', () => {
  it('holds the value that landed until the line it wrote is read back', async () => {
    const { instance, refresh, hears } = instanceHeard();
    let readBack!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => { readBack = resolve; }));
    pluginSyncOn({
      instance, channel,
      syncPlugins: () => { ambientWrites.name(['/profile/plugins.txt']); return Promise.resolve({ applied: true, wrote: true, added: [], dropped: [] }); },
    });

    let settled = false;
    const heard = hears().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ refreshed: refresh.mock.calls, settled }).toEqual({ refreshed: [[['/profile/plugins.txt']]], settled: false });

    readBack();
    await heard;
    expect(settled).toBe(true);
  });

  it('reads nothing back when the sync wrote nothing', async () => {
    const { instance, refresh, hears } = instanceHeard();
    pluginSyncOn({ instance, channel, syncPlugins: () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }) });

    await hears();

    expect(refresh).not.toHaveBeenCalled();
  });
});
