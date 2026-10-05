import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SETTING_SETTLE_MS, refreshOnGameDirectoryChange,
  type ConfigChangeEvent, type Subscription,
} from '../gameDirectorySetting';
const GAME_FOLDER_SETTING = 'modbench.mods.gameDirectory';

function fakeConfigChange() {
  let listener: ((e: ConfigChangeEvent) => void) | undefined;
  let disposed = false;
  const subscribe = (l: (e: ConfigChangeEvent) => void): Subscription => {
    listener = l;
    return { dispose: () => { disposed = true; listener = undefined; } };
  };
  return {
    subscribe,
    fire: (section: string) => listener?.({ affectsConfiguration: (s) => s === section }),
    get disposed() { return disposed; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('the game-directory setting reaches the Instance as one refresh', () => {
  it('refreshes once the settle has elapsed, not on the spot', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, config.subscribe, refresh);
    config.fire(GAME_FOLDER_SETTING);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of edits into one refresh', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, config.subscribe, refresh);
    for (let i = 0; i < 5; i++) {
      config.fire(GAME_FOLDER_SETTING);
      await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS / 2);
    }
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores a change to any other setting', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, config.subscribe, refresh);
    config.fire('modbench.attachToBackendPort');
    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('disposes both the subscription and a settle still in flight', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    const subscription = refreshOnGameDirectoryChange(GAME_FOLDER_SETTING, config.subscribe, refresh);
    config.fire(GAME_FOLDER_SETTING);
    subscription.dispose();
    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
    expect(config.disposed).toBe(true);
  });
});
