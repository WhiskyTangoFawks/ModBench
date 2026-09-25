import { describe, it, expect, vi } from 'vitest';
import { reportSkippedPlugins } from '../pluginFailures';
import type { components } from '../../wire/generated/api';

type PluginLoadFailure = components['schemas']['PluginLoadFailure'];

function failure(name: string, reason = 'could not be parsed'): PluginLoadFailure {
  return { name, origin: 'SomeMod', reason };
}

describe('reportSkippedPlugins', () => {
  it('says nothing when nothing was skipped', () => {
    const sink = { log: vi.fn(), warn: vi.fn() };

    reportSkippedPlugins([], sink);

    expect(sink.log).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
  });

  it('warns naming every skipped plugin and the Modbench output, and logs each reason', () => {
    const sink = { log: vi.fn(), warn: vi.fn() };

    reportSkippedPlugins([failure('A.esp'), failure('B.esp', 'unreadable header')], sink);

    expect(sink.log).toHaveBeenCalledWith("skipped plugin 'A.esp': could not be parsed");
    expect(sink.log).toHaveBeenCalledWith("skipped plugin 'B.esp': unreadable header");
    expect(sink.warn).toHaveBeenCalledWith(
      '2 plugin(s) were skipped — their records are NOT loaded: A.esp, B.esp. '
        + 'See the Modbench output for details.',
    );
  });
});
