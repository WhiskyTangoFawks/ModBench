// ADR-0015 invariant 7: a watcher event, activation and refresh run the same whole recompute,
// debounced once. An edited setting reaches the value as one of those refreshes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GAME_DIRECTORY_SECTION, SETTING_SETTLE_MS, refreshOnGameDirectoryChange,
  type ConfigChangeEvent, type Subscription,
} from '../gameDirectorySetting';

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
  it('names the setting the override lives at', () => {
    expect(GAME_DIRECTORY_SECTION).toBe('modbench.mods.gameDirectory');
  });

  it('refreshes once the settle has elapsed, not on the spot', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh);
    config.fire(GAME_DIRECTORY_SECTION);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Rival: a refresh per event, which runs one whole recompute per keystroke of a pasted path.
  it('coalesces a burst of edits into one refresh', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh);
    for (let i = 0; i < 5; i++) {
      config.fire(GAME_DIRECTORY_SECTION);
      await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS / 2);
    }
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Rival: refreshing on every configuration change, which recomputes the whole MO2 side on an
  // unrelated editor setting.
  it('ignores a change to any other setting', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh);
    config.fire('modbench.backendPort');
    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
  });

  // Rival: a settle left armed past teardown, firing a recompute into a disposed Instance.
  it('disposes both the subscription and a settle still in flight', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    const subscription = refreshOnGameDirectoryChange(config.subscribe, refresh);
    config.fire(GAME_DIRECTORY_SECTION);
    subscription.dispose();
    await vi.advanceTimersByTimeAsync(SETTING_SETTLE_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
    expect(config.disposed).toBe(true);
  });
});
