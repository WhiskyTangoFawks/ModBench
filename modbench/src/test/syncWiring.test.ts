import { describe, it, expect, vi } from 'vitest';
import { modSyncCommand, pluginSyncCommand } from '../syncWiring';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const syncDouble = () => ({
  run: vi.fn(() => Promise.resolve()),
  message: () => undefined,
  onMessageChanged: () => ({ dispose: () => undefined }),
  settled: () => Promise.resolve(),
});

describe('the sync commands take the instance value as their Argument', () => {
  it('mod sync runs on the arguments the handed value carries', async () => {
    const modSync = syncDouble();
    const value = instanceValueFixture({ activeProfile: 'Handed' });

    await modSyncCommand(modSync)(value);

    expect(modSync.run).toHaveBeenCalledWith(value.modSyncArguments);
  });

  it('plugin sync runs on the arguments the handed value carries', async () => {
    const pluginSync = syncDouble();
    const value = instanceValueFixture({ activeProfile: 'Handed' });

    await pluginSyncCommand(pluginSync)(value);

    expect(pluginSync.run).toHaveBeenCalledWith(value.pluginSyncArguments);
  });

  it('neither runs, nor says anything, when fired with no value', async () => {
    const modSync = syncDouble();
    const pluginSync = syncDouble();

    await modSyncCommand(modSync)();
    await pluginSyncCommand(pluginSync)();

    expect([modSync.run, pluginSync.run].map((run) => run.mock.calls.length)).toEqual([0, 0]);
  });
});
