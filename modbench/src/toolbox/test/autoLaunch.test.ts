import { describe, it, expect, vi } from 'vitest';
import { launchBackend, type LaunchDeps } from '../autoLaunch';
import type { ConfigChangeEvent } from '../gameDirectorySetting';

function harness(overrides: Partial<LaunchDeps> = {}) {
  let listener: ((e: ConfigChangeEvent) => void) | undefined;
  const reporter = { report: vi.fn() };
  const deps: LaunchDeps = {
    setting: 'modbench.mods.gameDirectory',
    client: { status: 'stopped' },
    enterEditing: vi.fn().mockResolvedValue(undefined),
    exitEditing: vi.fn(),
    reporter,
    onConfigChange: (l) => { listener = l; return { dispose: vi.fn() }; },
    ...overrides,
  };
  const subscription = launchBackend(deps);
  const change = (section: string) => listener?.({ affectsConfiguration: (s) => s === section });
  return { deps, reporter, subscription, change };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the backend launches with the extension, and a change to the game folder setting is its only retry', () => {
  it('enters editing at once', () => {
    const { deps } = harness();
    expect(deps.enterEditing).toHaveBeenCalledTimes(1);
  });

  it('enters editing again when the setting changes while the backend is not running', () => {
    const { deps, change } = harness();
    change('modbench.mods.gameDirectory');
    expect(deps.enterEditing).toHaveBeenCalledTimes(2);
  });

  it('leaves a running backend alone when the setting changes', () => {
    const { deps, change } = harness({ client: { status: 'running' } });
    change('modbench.mods.gameDirectory');
    expect(deps.enterEditing).toHaveBeenCalledTimes(1);
  });

  it('ignores another setting', () => {
    const { deps, change } = harness();
    change('modbench.somethingElse');
    expect(deps.enterEditing).toHaveBeenCalledTimes(1);
  });

  it('launches nothing outside an instance', () => {
    const { reporter, change } = harness({ enterEditing: undefined });
    change('modbench.mods.gameDirectory');
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('tears down a half-started backend and reports the failure', async () => {
    const { deps, reporter } = harness({ enterEditing: vi.fn().mockRejectedValue(new Error('no port')) });
    await flush();
    expect(deps.exitEditing).toHaveBeenCalledTimes(1);
    expect(reporter.report).toHaveBeenCalledWith('error', 'Failed to launch mEdit.', 'no port');
  });
});
