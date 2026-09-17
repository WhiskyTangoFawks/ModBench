// ADR-0015 invariant 7: a watcher event, activation and refresh run the same whole recompute,
// debounced once. An edited setting reaches the value as one of those refreshes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GAME_DIRECTORY_SECTION, refreshOnGameDirectoryChange,
  type ConfigChangeEvent, type Subscription,
} from '../gameDirectorySetting';

const SETTLE = 200;

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

describe('the game-directory setting reaches the Instance as a recompute', () => {
  it('refreshes after the settle when the setting changes', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh, SETTLE);
    config.fire(GAME_DIRECTORY_SECTION);
    expect(refresh).not.toHaveBeenCalled(); // the settle has not elapsed

    await vi.advanceTimersByTimeAsync(SETTLE);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('names the setting the override lives at', () => {
    expect(GAME_DIRECTORY_SECTION).toBe('modbench.mods.gameDirectory');
  });

  // Rival: refreshing on every configuration change, which recomputes the whole MO2 side on an
  // unrelated editor setting.
  it('ignores a change to any other setting', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh, SETTLE);
    config.fire('modbench.mods.language');
    await vi.advanceTimersByTimeAsync(SETTLE * 5);

    expect(refresh).not.toHaveBeenCalled();
  });

  // Rival: refreshing on the spot, which lands a recompute per keystroke of a pasted path.
  it('coalesces a burst of edits into one recompute', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    refreshOnGameDirectoryChange(config.subscribe, refresh, SETTLE);
    config.fire(GAME_DIRECTORY_SECTION);
    await vi.advanceTimersByTimeAsync(SETTLE / 2);
    config.fire(GAME_DIRECTORY_SECTION);
    await vi.advanceTimersByTimeAsync(SETTLE / 2);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTLE);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Rival: a settle left armed past teardown, firing a recompute into a disposed Instance.
  it('disposes both the subscription and a settle still in flight', async () => {
    vi.useFakeTimers();
    const config = fakeConfigChange();
    const refresh = vi.fn().mockResolvedValue(undefined);

    const subscription = refreshOnGameDirectoryChange(config.subscribe, refresh, SETTLE);
    config.fire(GAME_DIRECTORY_SECTION);
    subscription.dispose();
    await vi.advanceTimersByTimeAsync(SETTLE * 5);

    expect(refresh).not.toHaveBeenCalled();
    expect(config.disposed).toBe(true);
  });
});
