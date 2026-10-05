import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, showInputBox } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showInputBox: vi.fn(),
  };
});

import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand: vi.fn() },
    window: { showInputBox, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  };
});

import { progressSteps } from '../../test/recordedProgress';
import { registerRenamePluginCommand } from '../pluginRenameCommand';
import { ImplicitMasterNode, PluginNode, type PluginsTreeNode } from '../PluginsTreeProvider';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { accessTo } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import type { LoadOrderPlugin } from '../../instanceLoader/loadOrderSnapshot';

const held = (name: string, origin: string): LoadOrderPlugin =>
  ({ name, origin, path: `/instance/mods/${origin}/${name}`, slot: null, enabled: true, winning: true });

const PLUGIN = { name: 'Patch.esp', origin: 'ModA' };

function setup(selection: readonly PluginsTreeNode[] = []) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getLightPluginsSupported', true);
  client.setCommandResult('renameSource', { renamed: true });
  const renameFiles = vi.fn().mockResolvedValue(undefined);
  const access = { ...accessTo('/instance'), adapter: { ...accessTo('/instance').adapter, renamePlugin: renameFiles } };
  const instance = {
    value: instanceValueFixture({
      gameRelease: 'Fallout4',
      plugins: [held('Patch.esp', 'ModA'), held('Taken.esp', 'ModA'), held('Elsewhere.esp', 'ModB')],
    }),
    quiet: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } finally {
        progressSteps.push('Instance loader: read every file again');
      }
    },
  };
  const reporter = recordingReporter();
  registerRenamePluginCommand({ client, access, instance, reporter }, () => selection);
  const run = present(handlers.get('modbench.plugin.rename'), 'the rename plugin command');
  const validate = async (value: string): Promise<string | undefined> => {
    showInputBox.mockImplementationOnce((options: { validateInput: (v: string) => unknown }) => {
      validated = options.validateInput(value);
      return Promise.resolve(undefined);
    });
    let validated: unknown;
    await run(new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin));
    return validated as string | undefined;
  };
  return { client, renameFiles, reporter, run, validate };
}

const row = () => new PluginNode({ name: PLUGIN.name, enabled: true }, PLUGIN.origin);

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.plugin.rename', () => {
  it('asks with the current name filled in, then renames the source and the file, under the Plugins bar and a read after', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, run } = setup();

    await run(row());

    expect(showInputBox).toHaveBeenCalledWith(expect.objectContaining({ value: 'Patch.esp' }));
    expect(client.calls.filter((c) => c.method === 'renameSource')).toEqual([{ method: 'renameSource', args: [PLUGIN, 'Renamed.esp'] }]);
    expect(renameFiles).toHaveBeenCalledWith({ kind: 'mod', name: 'ModA' }, 'Patch.esp', 'Renamed.esp', 'Fallout4');
    expect(progressSteps).toEqual(['progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes']);
    expect(reporter.reports).toEqual([]);
  });

  it('takes the one selected plugin from a key or the palette, which pass no row', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, run } = setup([row()]);

    await run();

    expect(client.calls.filter((c) => c.method === 'renameSource')).toHaveLength(1);
  });

  it.each([['Esc', undefined], ['an empty name', ''], ['the same name', 'Patch.esp']])('renames nothing on %s', async (_, answer) => {
    showInputBox.mockResolvedValueOnce(answer);
    const { client, renameFiles, run } = setup();

    await run(row());

    expect(client.calls.filter((c) => c.method === 'renameSource')).toEqual([]);
    expect(renameFiles).not.toHaveBeenCalled();
    expect(progressSteps).toEqual([]);
  });

  it('takes nothing from a row that is no plugin line', async () => {
    const { client, run } = setup();

    await run(new ImplicitMasterNode('Fallout4.esm', 'Data'));

    expect(showInputBox).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
  });

  describe('the prompt refuses what Create plugin refuses, compared without case', () => {
    it('lets the empty name and the same name through to renaming nothing', async () => {
      const { validate } = setup();
      expect(await validate('')).toBeUndefined();
      expect(await validate('Patch.esp')).toBeUndefined();
    });

    it('refuses a name with no plugin extension, and .esl where the game has no light plugins', async () => {
      const { validate, client } = setup();
      expect(await validate('Patch.txt')).toBe('Extension must be .esp, .esm, or .esl');
      client.setQueryAnswer('getLightPluginsSupported', false);
      expect(await validate('Patch.esl')).toBe('This game has no light plugins');
    });

    it('refuses a name the plugin\'s own place holds, a case-only rename of itself too', async () => {
      const { validate } = setup();
      expect(await validate('taken.ESP')).toBe('"ModA" already holds "taken.ESP".');
      expect(await validate('PATCH.esp')).toBe('"ModA" already holds "PATCH.esp".');
    });

    it('lets through a name only another place holds', async () => {
      const { validate } = setup();
      expect(await validate('Elsewhere.esp')).toBeUndefined();
    });
  });

  it('tells a refused source, writing no file', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { client, renameFiles, reporter, run } = setup();
    client.setCommandResult('renameSource', { refused: true, message: 'Could not rename the source of "Patch.esp" — NotTracked' });

    await run(row());

    expect(renameFiles).not.toHaveBeenCalled();
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not rename the source of "Patch.esp" — NotTracked', detail: undefined },
    ]);
  });

  it('names the plugin and says its source was renamed when the file and lines failed after it', async () => {
    showInputBox.mockResolvedValueOnce('Renamed.esp');
    const { renameFiles, reporter, run } = setup();
    renameFiles.mockRejectedValueOnce(new Error('disk full'));

    await run(row());

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not rename "Patch.esp" (ModA): its plugin source was renamed, its file and lines were not. Reverting the source rename in git undoes it.',
      detail: 'disk full',
    }]);
  });
});
